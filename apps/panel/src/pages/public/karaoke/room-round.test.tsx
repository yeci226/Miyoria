// A whole room round, end to end, against the real Core (docs/design/karaoke.md 「做了什麼第四步」):
// two singers and a spectator, each in their own page, sing a round that ends by itself at the end
// of the backing (nobody presses 唱完了). The pages talk to Core's own routes (the route table with
// its contract checks and the member rate limit, and the room's plain routes: events, clock, audio,
// pitch, files) over a `RoomDesk` and a `KaraokeService` on an in-memory store, with the fake song
// worker and wallet Core's tests use. Everything runs on one fake clock: Core's `now`, the pages'
// timers, animation frames, `performance.now` and `Date.now`, and each page's fake audio engine
// (its context time is `performance.now`, its microphone and pitch are fed by the test). So the
// round takes no real time and does not depend on the machine's speed.
//
// Core is TypeScript under `packages/`, which the panel's Vite does not resolve (its workspace
// imports need the `@miyoria/source` condition). It is loaded through Node itself: tsx for the
// TypeScript, a resolve hook for the condition, all in one graph so its classes are shared.

import { fireEvent, render, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KaraokeRoomEvent, KaraokeRoomView } from "@miyoria/contracts/api";
import { ConnectionProvider } from "@/app/connection";
import { createQueryClient } from "@/app/query-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { KaraokeEngine, MicStream } from "./audio";
import { setEngineFactory } from "./audio";
import { KaraokePage } from "./KaraokePage";
import type { StreamPiece } from "./mulaw";
import type { Detection } from "./pitch";
import { setRoomEventsFactory } from "./room-api";
import { RoomPage } from "./RoomPage";

// ---- Core, loaded by Node ------------------------------------------------------------------------

// Core's modules are loaded outside the panel's types.
type Any = any;

const realImmediate = (globalThis as Any).setImmediate as (fn: () => void) => void;
const realTimeout = globalThis.setTimeout.bind(globalThis);
/** One turn of the real event loop (I/O, React's scheduler). */
const turn = () => new Promise<void>((r) => realImmediate(r));

async function loadCore(): Promise<Any> {
  const name = (s: string) => s;
  const g = globalThis as Any;
  const mod = await import(/* @vite-ignore */ name("node:module"));
  const url = await import(/* @vite-ignore */ name("node:url"));
  const path = await import(/* @vite-ignore */ name("node:path"));
  const buffer = await import(/* @vite-ignore */ name("node:buffer"));
  // esbuild (under tsx) checks that `TextEncoder` makes this realm's `Uint8Array`; jsdom swaps the
  // global one for its own, so Node's stands in while it loads.
  const jsdomU8 = g.Uint8Array;
  g.Uint8Array = Object.getPrototypeOf(buffer.Buffer.prototype).constructor;
  let tsx: Any;
  try {
    tsx = await import(/* @vite-ignore */ name("tsx/esm/api"));
  } finally {
    g.Uint8Array = jsdomU8;
  }
  const hook =
    'export async function resolve(s, c, n) { return n(s, { ...c, conditions: [...new Set([...c.conditions, "@miyoria/source"])] }); }';
  mod.register(`data:text/javascript,${encodeURIComponent(hook)}`);
  const root = path.resolve(url.fileURLToPath(import.meta.url), "../../../../../../..");
  const file = (p: string) => JSON.stringify(url.pathToFileURL(path.join(root, p)).href);
  const entry = [
    `export * as routes from ${file("packages/api/src/karaoke-routes.ts")};`,
    `export * as rpc from ${file("packages/api/src/rpc.ts")};`,
    `export * as publicSide from ${file("packages/api/src/public.ts")};`,
    `export * as errors from ${file("packages/api/src/errors.ts")};`,
    `export * as play from ${file("packages/play/karaoke/src/index.ts")};`,
    `export * as testing from ${file("packages/play/karaoke/src/testing.ts")};`,
    `export * as store from ${file("packages/store/src/testing.ts")};`,
    `export { Hono } from ${file("packages/api/node_modules/hono/dist/index.js")};`,
  ].join("\n");
  const core = await tsx.tsImport(`data:text/javascript,${encodeURIComponent(entry)}`, import.meta.url);
  const fs = await import(/* @vite-ignore */ name("node:fs/promises"));
  const os = await import(/* @vite-ignore */ name("node:os"));
  return { ...core, fs, os, path };
}

const ACCOUNTS = {
  alice: { platform: "discord", id: "1" },
  bob: { platform: "discord", id: "2" },
  carol: { platform: "discord", id: "3" },
} as const;
type Who = keyof typeof ACCOUNTS;
const NAMES: Record<Who, string> = { alice: "小魚乾", bob: "海苔", carol: "路過的人" };
const hostOf = (who: Who) => `${who}.test`;
const baseOf = (who: Who) => `http://${hostOf(who)}`;
const whoOfHost = (host: string): Who | null =>
  (Object.keys(ACCOUNTS) as Who[]).find((w) => hostOf(w) === host) ?? null;

/** What every request answered that was not a success: the refusals the round met. */
interface Refusal {
  who: Who;
  method: string;
  path: string;
  status: number;
  body: string;
}

async function makeCore(core: Any, songSeconds: number) {
  const { play, testing, store: storeTesting, rpc, routes, publicSide, errors, Hono, fs, os, path } = core;
  const raw = storeTesting.openTestDb({ identity: true, plugins: [play.karaokeSchema] });
  const worker = new testing.FakeKaraokeWorker();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "karaoke-room-round-"));
  const config = play.KaraokeConfigSchema.parse({ comment_channel: "discord:111111:222222", open: true });
  const store = new play.KaraokeStore(raw.db, raw.events);
  const who = (account: { id: string }) => ({ person: `p-${account.id}`, blocked: false });
  const logs: { level: string; obj: unknown; msg: string }[] = [];
  const log = {
    info: (obj: unknown, msg: string) => logs.push({ level: "info", obj, msg }),
    warn: (obj: unknown, msg: string) => logs.push({ level: "warn", obj, msg }),
  };
  const now = () => Date.now();
  const service = new play.KaraokeService({
    config,
    store,
    worker: () => worker,
    now,
    cacheDir: dir,
    who,
    tell: () => {},
    together: () => {},
    log,
  });
  const wallet = new testing.FakeKaraokeWallet({ "1": "p-1", "2": "p-2", "3": "p-3" }, now);
  for (const p of ["p-1", "p-2", "p-3"]) wallet.balances.set(p, 50);
  const desk = new play.RoomDesk({
    config,
    store,
    service,
    worker: () => worker,
    wallet: () => wallet,
    inVoice: () => true,
    who,
    tell: () => {},
    together: () => {},
    now,
    log,
  });
  service.attachRooms(desk);
  // The real member limit (60 a minute per account) on the table's `limited` routes.
  const side = new publicSide.PublicSide(publicSide.PublicConfigSchema.parse({ enabled: true }), now);
  const state = {
    publicSide: side,
    optional: () => undefined,
    service: (key: unknown, what: string) => {
      if (key === play.KaraokeKey) return service;
      if (key === play.KaraokeRoomsKey) return desk;
      throw errors.ApiError.unavailable(`${what} is not available`);
    },
  };
  const table = {
    karaoke: routes.karaokeRpc,
    karaokeAdmin: routes.karaokeAdminRpc,
    karaokeRooms: routes.karaokeRoomsRpc,
  };
  const app = new Hono();
  for (const r of [...rpc.tableRoutes(state, table, { responseCheck: "strict" }), ...routes.karaokeRoutes(state)]) {
    app.on(r.method, r.path, async (c: Any) => {
      const w = c.req.header("x-test-account") as Who;
      if (r.member) c.set("member", { account: ACCOUNTS[w], name: NAMES[w], tier: "member" });
      try {
        const res: Response = await r.handler(c);
        const headers = new Headers(res.headers);
        headers.set("cache-control", "no-store");
        return new Response(res.body, { status: res.status, headers });
      } catch (error) {
        return error instanceof errors.ApiError ? (error as Any).toResponse() : errors.ApiError.internal(error).toResponse();
      }
    });
  }
  // A ready song of about `songSeconds`.
  const phrases = Math.max(2, Math.round((songSeconds - 2) / 5.6));
  const song = testing.synthSong(5, phrases);
  const asked = await service.request(ACCOUNTS.alice, "https://youtu.be/room-round", true);
  const job = store.song(asked.song.id)?.job as string;
  worker.finish(job, testing.referenceOf(song, `k-${job}`, "紙船"));
  await service.tick(new AbortController().signal);
  const ready = service.overview(ACCOUNTS.alice).songs[0];
  return { app, desk, service, store, worker, wallet, raw, dir, logs, song, songId: ready.id as string, duration: ready.duration_s as number, core };
}

type Rig = Awaited<ReturnType<typeof makeCore>>;

// ---- the pages' side: fetch and the event stream into Core ---------------------------------------

function wire(rig: Rig, refusals: Refusal[]) {
  const send = async (who: Who, method: string, pathAndQuery: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("x-test-account", who);
    const B = (globalThis as Any).Buffer;
    const body = init?.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? init.body : B.from(init.body as Uint8Array);
    const request = new Request(`http://core.test${pathAndQuery}`, { method, headers, body });
    return (await rig.app.fetch(request)) as Response;
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const who = whoOfHost(u.host);
    if (who === null) throw new TypeError(`no such page: ${u.host}`);
    const method = init?.method ?? "GET";
    const res = await send(who, method, u.pathname + u.search, init);
    if (!res.ok) {
      const text = await res.clone().text();
      refusals.push({ who, method, path: u.pathname, status: res.status, body: text });
    }
    return res;
  });
  // The event stream: Core's own route, its Server-Sent Events read as a browser would.
  setRoomEventsFactory((streamUrl, h) => {
    const u = new URL(streamUrl);
    const who = whoOfHost(u.host) as Who;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let closed = false;
    void (async () => {
      const res = await send(who, "GET", u.pathname);
      if (!res.ok || res.body === null) {
        refusals.push({ who, method: "GET", path: u.pathname, status: res.status, body: await res.text() });
        h.onLink?.("retrying");
        return;
      }
      h.onLink?.("open");
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done || closed) return;
        text += decoder.decode(value, { stream: true });
        let cut = text.indexOf("\n\n");
        while (cut >= 0) {
          const block = text.slice(0, cut);
          text = text.slice(cut + 2);
          const m = /^event: (\w+)\ndata: (.*)$/m.exec(block);
          if (m) h.onEvent(JSON.parse(m[2] as string) as KaraokeRoomEvent);
          cut = text.indexOf("\n\n");
        }
      }
    })();
    return () => {
      closed = true;
      void reader?.cancel().catch(() => undefined);
    };
  });
  return send;
}

// ---- a page's audio, on the fake clock -----------------------------------------------------------

/** A page's engine: context time is `performance.now`; the test feeds its microphone and pitch. */
function fakeEngine(duration: number, voice: (songTime: number) => number | null) {
  const listeners = new Set<(d: Detection) => void>();
  let playing: { at: number; offset: number } | null = null;
  let mic = false;
  let stream: ((p: StreamPiece) => void) | null = null;
  let index = 0;
  let fedTo = 0;
  const now = () => performance.now() / 1000;
  const engine: KaraokeEngine = {
    now,
    heard: now,
    estimateLatencyMs: () => 40,
    openMic: async () => {
      mic = true;
      fedTo = now();
      return { deviceId: "test-mic" };
    },
    setFloor: () => {},
    onDetection: (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    loadBacking: async () => duration,
    play: (offset) => {
      const at = now() + 0.12;
      playing = { at, offset };
      return at;
    },
    playAt: (at, offset) => {
      let when = at;
      let from = offset;
      const earliest = now() + 0.05;
      if (when < earliest) {
        from += earliest - when;
        when = earliest;
      }
      playing = { at: when, offset: from };
      return { at: when, offset: from };
    },
    stop: () => {
      playing = null;
    },
    beeps: () => {},
    recorder: () => null,
    micStream: async () => {
      const m: MicStream = {
        start: (on) => {
          stream = on;
          index = 0;
        },
        stop: () => {
          stream = null;
        },
      };
      return m;
    },
    close: () => {},
  };
  /** What the microphone heard up to now: a detection every 10 ms, the stream in one piece. */
  const feed = () => {
    if (!mic) return;
    const to = now();
    if (stream !== null && to > fedTo) {
      const n = Math.round((to - fedTo) * 16_000);
      if (n > 0) {
        stream({ index, t: fedTo, bytes: new Uint8Array(n).fill(0xff) });
        index += n;
      }
    }
    for (let t = Math.ceil(fedTo * 100) / 100; t < to; t += 0.01) {
      const song = playing === null ? null : playing.offset + (t - playing.at);
      const midi = song !== null && song >= 0 && song <= duration ? voice(song) : null;
      const d: Detection = { t, midi, clarity: midi === null ? 0.2 : 0.95, rms: 0.05, level: 0.001, levelT: t } as Detection;
      for (const f of listeners) f(d);
    }
    fedTo = to;
  };
  return { engine, feed, playing: () => playing };
}


// ---- rendering a page as one person --------------------------------------------------------------

function Providers({ who, children }: { who: Who; children: ReactNode }) {
  const [queryClient] = useState(() => createQueryClient());
  return (
    <ConnectionProvider initial={{ baseUrl: baseOf(who), token: "" }}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
      </QueryClientProvider>
    </ConnectionProvider>
  );
}

// ---- the round -----------------------------------------------------------------------------------

let core: Any = null;

beforeAll(async () => {
  core = await loadCore();
}, 120_000);

afterAll(() => {
  setEngineFactory(() => {
    throw new Error("no engine");
  });
});

interface RoundOptions {
  /** About how long the song is, in seconds. */
  songSeconds: number;
  /**
   * The singers' pages draw no frames during the song: a tab in the background, a window covered
   * by another one (Chrome on Windows counts that as hidden), a phone's screen off. The backing,
   * the microphone and the timers go on (slower timers, in a real browser).
   */
  hidden: boolean;
}

/** A whole round, from the opener's 開始 to the ranking on every page. */
async function playRound(o: RoundOptions) {
  (globalThis as Any).IS_REACT_ACT_ENVIRONMENT = false;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"],
    now: Date.UTC(2026, 10, 18, 12, 0, 0),
  });
  const rig = await makeCore(core, o.songSeconds);
  const refusals: Refusal[] = [];
  const send = wire(rig, refusals);
  const call = async (who: Who, method: string, p: string, body?: unknown) => {
    const res = await send(who, method, p, body === undefined ? undefined : { body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { status: res.status, body: (await res.json().catch(() => null)) as Any };
  };
  const ticks = window.setInterval(() => void rig.desk.tick(), 250);
  const serviceTicks = window.setInterval(() => void rig.service.tick(new AbortController().signal), 1_000);
  const frames = window.requestAnimationFrame;
  const views: ReturnType<typeof render>[] = [];
  try {
    // The lobby, as the pages would have done it: Alice opens (no song) and queues the song, Bob
    // sings, Carol watches.
    const opened = await call("alice", "POST", "/api/member/karaoke/rooms", {});
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const code = opened.body.code as string;
    const queued = await call("alice", "POST", `/api/member/karaoke/rooms/${code}/queue`, { song: rig.songId, shift: 0 });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    expect(queued.body.next).toBe(queued.body.queue[0].id);
    expect((await call("bob", "POST", `/api/member/karaoke/rooms/${code}/join`, { as: "singer" })).status).toBe(200);
    expect((await call("carol", "POST", `/api/member/karaoke/rooms/${code}/join`, { as: "spectator" })).status).toBe(200);
    for (const w of ["alice", "bob"] as const) {
      expect((await call(w, "POST", `/api/member/karaoke/rooms/${code}/ready`, { ready: true, latency_ms: 40, calibrated: true })).status).toBe(200);
    }

    // Alice sings the whole song; Bob is in it but does not sing.
    const sung = rig.core.testing.humanSinger(rig.song, { seed: 3, hz: 100 }).midi as (number | null)[];
    const alice = fakeEngine(rig.duration, (t) => sung[Math.round(t * 100)] ?? null);
    const bob = fakeEngine(rig.duration, () => null);
    const carol = fakeEngine(rig.duration, () => null);
    const engines = [alice, bob, carol];
    setEngineFactory(() => alice.engine);

    /** Fake time moves on `ms` (in small steps), the real loop gets a few turns in between. */
    const pass = async (ms: number, step = 20) => {
      for (let t = 0; t < ms; t += step) {
        for (const e of engines) e.feed();
        await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
        for (let i = 0; i < 3; i++) await turn();
      }
    };
    /** Until `cond`: the real loop turns (I/O), fake time moves `step` a round. */
    const until = async (cond: () => boolean, what: string, step = 10, most = 3_000) => {
      for (let i = 0; i < most; i++) {
        if (cond()) return;
        await pass(step, step);
        if (i % 50 === 49) await new Promise((r) => realTimeout(r, 2));
      }
      throw new Error(`never: ${what}`);
    };

    // Alice's page is the whole member page at the room's address; Bob's and Carol's the room page.
    window.history.replaceState(null, "", `/karaoke/room/${code}`);
    const pageProps = {
      code,
      latency: { latency_ms: 40, calibrated: true },
      floor: null,
      prepareMic: async () => ({ latency_ms: 40, calibrated: true }),
      onCalibrate: () => {},
      onExit: () => {},
    };
    const overview = rig.service.overview(ACCOUNTS.bob);
    const bobEngine = () => bob.engine;
    const carolEngine = () => carol.engine;
    views.push(
      render(
        <Providers who="alice">
          <KaraokePage member={{ name: NAMES.alice, avatar_url: null } as never} home="/" />
        </Providers>,
      ),
      render(
        <Providers who="bob">
          <RoomPage {...pageProps} overview={overview} engine={bobEngine} />
        </Providers>,
      ),
      render(
        <Providers who="carol">
          <RoomPage {...pageProps} overview={overview} engine={carolEngine} />
        </Providers>,
      ),
    );
    const pageOf: Record<Who, HTMLElement> = { alice: views[0]?.container as HTMLElement, bob: views[1]?.container as HTMLElement, carol: views[2]?.container as HTMLElement };
    const has = (who: Who, label: string) => within(pageOf[who]).queryByRole("region", { name: label }) !== null;

    await until(() => within(pageOf.alice).queryByRole("button", { name: "開始" }) !== null, "the opener's start button");
    fireEvent.click(within(pageOf.alice).getByRole("button", { name: "開始" }));

    // Everyone's stage comes up with the countdown.
    await until(() => has("alice", "唱 紙船") && has("bob", "唱 紙船") && has("carol", "看 紙船"), "the stages");
    const sessionOf = async (w: Who) => (await call(w, "GET", `/api/member/karaoke/rooms/${code}`)).body.me.session.session as string;
    const sessions = { alice: await sessionOf("alice"), bob: await sessionOf("bob") };
    rig.worker.streamTracks.set(sessions.alice, rig.core.testing.humanSinger(rig.song, { seed: 3, hz: 50 }).midi);
    rig.worker.streamTracks.set(sessions.bob, []);
    const startAt = (await call("carol", "GET", `/api/member/karaoke/rooms/${code}`)).body.start_at_ms as number;
    const end = startAt + rig.duration * 1000;
    if (o.hidden) window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame;

    // The song, to its end and on, until the round settles (or Core's last wait would be over).
    let settledAt: number | null = null;
    const view = () => rig.desk.view(code, ACCOUNTS.carol) as KaraokeRoomView;
    while (Date.now() < end + 130_000) {
      await pass(500);
      if (view().state === "results") {
        settledAt = Date.now();
        break;
      }
    }
    window.requestAnimationFrame = frames;

    const results = { alice: rig.store.result(sessions.alice), bob: rig.store.result(sessions.bob) };
    const statuses = { alice: rig.store.session(sessions.alice)?.status, bob: rig.store.session(sessions.bob)?.status };
    const report = JSON.stringify(
      {
        refusals,
        results: { alice: results.alice !== null, bob: results.bob !== null },
        statuses,
        settled_after_song_s: settledAt === null ? null : (settledAt - end) / 1000,
        warnings: rig.logs.filter((l) => l.level === "warn"),
      },
      null,
      1,
    );
    expect(refusals, report).toEqual([]);
    expect(results.alice, report).not.toBeNull();
    expect(results.bob, report).not.toBeNull();
    expect(settledAt, report).not.toBeNull();
    // Right after the song: both results and the streams' last word, not Core's last-resort wait.
    expect((settledAt as number) - end, report).toBeLessThan(10_000);
    // Each result is the one this browser sent, scored officially from its stream.
    expect(results.alice?.source, report).toBe("voice");

    // The ranking comes up by itself on every page.
    await until(() => has("alice", "這一輪的名次") && has("bob", "這一輪的名次") && has("carol", "這一輪的名次"), "the results on every page");
    const ranking = within(pageOf.carol).getByRole("region", { name: "這一輪的名次" });
    expect(ranking).toHaveTextContent(NAMES.alice);
    expect(ranking).toHaveTextContent(NAMES.bob);
  } finally {
    window.requestAnimationFrame = frames;
    window.clearInterval(ticks);
    window.clearInterval(serviceTicks);
    for (const v of views) v.unmount();
    vi.useRealTimers();
    rig.raw.close();
    await rig.core.fs.rm(rig.dir, { recursive: true, force: true });
  }
}

describe("一起唱: a whole round against Core", () => {
  it("two singers and a spectator, the song ends by itself: both results are in and the round settles right after", { timeout: 120_000 }, async () => {
    await playRound({ songSeconds: 60, hidden: false });
  });

  it("the same with the singers' pages in the background (no animation frames), a song as long as the live one", { timeout: 240_000 }, async () => {
    await playRound({ songSeconds: 237, hidden: true });
  });
});
