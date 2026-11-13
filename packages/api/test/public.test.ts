// The public side against the real server: anonymous visitors, member sessions and blocked people
// against every route, what a response may hold, and the limits. Internal fields in the fixtures
// are poisoned with `SECRET`, so a field that leaks fails the tests whichever route it leaks from.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActuatorRegistry, ActuatorRegistryKey, defineCapability } from "@miyoria/actions";
import { AuthService, AuthServiceKey } from "@miyoria/auth";
import { EconomyConfigSchema, EconomyKey, EconomyService } from "@miyoria/economy";
import {
  defineManifest,
  getLogger,
  type Module,
  type ModuleContext,
  Supervisor,
  SupervisorKey,
} from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import { MemoryEngineKey } from "@miyoria/memory";
import { SingerKey, type SongEntry } from "@miyoria/sing";
import {
  AuditLogKey,
  AuthStoreKey,
  BountyStoreKey,
  CoinLedgerStoreKey,
  DealStoreKey,
  FortuneStoreKey,
  GoalStoreKey,
  MemberCardStoreKey,
  type MemoryRecord,
  MemorySettingsStore,
  MessageLogKey,
  PeopleStoreKey,
  SettingsStoreKey,
  SqliteStore,
} from "@miyoria/store";
import {
  type AccountRef,
  ActivityManagerKey,
  type ActivitySnapshot,
  type AffectState,
  AffectStateKey,
  AuthorizerKey,
  type BondChange,
  type ContextKey,
  customEvent,
  DirectivesKey,
  type Envelope,
  type JsonValue,
  KeepsakesKey,
  ModerationKey,
  newEnvelope,
  type PersonCard,
  type PersonId,
  SelfStateKey,
  SONG_TOPIC,
  SocialSignalsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CARD_POSES, CARDS_PER_DAY, normalizeSerial } from "../src/card.js";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { acceptableQuery, affinityBand, familiarityBand, trustBand } from "../src/member.js";
import { cardMeta, injectMeta } from "../src/meta.js";
import { Monitor } from "../src/monitor.js";
import { cardVersion } from "../src/og.js";
import {
  clientKey,
  PUBLIC_DAYS,
  PUBLIC_STATS_KEY,
  PublicConfigSchema,
  PublicSide,
  PublicStats,
  RateWindow,
} from "../src/public.js";
import { routes } from "../src/server.js";
import { Sessions } from "../src/session.js";
import { ApiState } from "../src/state.js";
import type { IssuedCard } from "../src/types.js";
import { listenFetchable, type RawResponse, raw } from "./support/http.js";
import { TestStore } from "./support/stores.js";

const TOKEN = "test-token";
const OWNER = "111";
const ALICE = "222";
const BOB = "333";
const CAROL = "444"; // blocked by the social tag
const DAVE = "555"; // never met
const ERIN = "666"; // blocked by role
const FRANK = "777"; // blocked on the card only

const REDIRECT = "http://panel.test/api/auth/oauth/callback";
const USERS: Record<string, [string, string]> = {
  owner: [OWNER, "Owner"],
  alice: [ALICE, "Alice"],
  bob: [BOB, "Bob"],
  carol: [CAROL, "Carol"],
  dave: [DAVE, "Dave"],
  erin: [ERIN, "Erin"],
  frank: [FRANK, "Frank"],
};

const discord = (id: string): AccountRef => ({ platform: "discord", id });

const GUILD: ContextKey = {
  platform: "discord",
  scope: "SECRET-guild",
  channel: "SECRET-channel",
  kind: "channel",
};
const AT = "2026-11-07T12:00:00.000Z";

function song(no: number, over: Partial<SongEntry> = {}): SongEntry {
  return {
    no,
    query: "SECRET-query",
    key: 0,
    backing: "keep",
    requester: discord(BOB),
    requester_name: "SECRET-requester",
    context: GUILD,
    forced: false,
    state: "ready",
    stage: "SECRET-stage",
    progress: 1,
    error: "SECRET-error",
    job: "SECRET-job",
    song: {
      id: "SECRET-song-id",
      title: `Title ${no}`,
      artist: "Artist",
      duration_s: 200,
      lyrics: null,
      play: { sample_rate: 44100, samples: 1 },
      pitch: {},
      timings: {},
      peak_vram_mb: 1,
      has_video: true,
      video: { file: "SECRET-file" },
    },
    queue_item: null,
    ticket_entry: null,
    dedication: null,
    dedication_entry: null,
    created_at: AT,
    ready_at: AT,
    reminders: 0,
    last_reminder_ms: null,
    ...over,
  };
}

function memory(id: string, over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id,
    profile: "p",
    kind: "episode",
    scope: { type: "guild", platform: "discord", guild: "SECRET-guild" },
    subjects: [],
    content: "",
    tokens: "SECRET-tokens",
    embedding: null,
    importance: 0.5,
    confidence: 0.5,
    created_at: AT,
    updated_at: AT,
    last_accessed: null,
    access_count: 7,
    source_context: GUILD,
    source: null,
    origin: "experienced",
    source_events: ["SECRET-event"],
    superseded_by: null,
    ...over,
  } as MemoryRecord;
}

function card(person: PersonId, handle: string, over: Partial<PersonCard> = {}): PersonCard {
  return {
    person,
    handle,
    call_name: null,
    affinity: 60,
    trust: 50,
    familiarity: 40,
    attachment: 0.91,
    emotions: { missing: 0.6 },
    feeling: `SECRET-feeling ${handle} 跟 Bob 比起來`,
    public_feeling: null,
    label: "好朋友",
    level: 12,
    owner: false,
    blocked: false,
    last_seen: AT,
    last_together: null,
    updated_at: AT,
    ...over,
  };
}

interface Rig {
  sup: Supervisor;
  base: string;
  store: TestStore;
  auth: AuthService;
  people: Map<string, PersonId>;
  cards: Map<PersonId, PersonCard>;
  songs: SongEntry[];
  memories: Map<PersonId, MemoryRecord[]>;
  derived: MemoryRecord[];
  forgotten: { person: PersonId | null; account: AccountRef }[];
  bonds: { person: PersonId; change: BondChange }[];
  requested: { args: unknown; kind: string; requester: AccountRef | null }[];
  bus: Envelope[];
  counters: { songs: number; activity: number };
  rule: { deny: string | null };
  /** What the injected `random` returns. */
  dice: { value: number };
  /** Logs in as `code`; returns the session cookie. */
  login(code: string): Promise<string>;
  loginResult(code: string): Promise<{ location: string; cookie: string | null }>;
  get(path: string, cookie?: string, headers?: Record<string, string>): Promise<RawResponse>;
  post(path: string, cookie: string, json?: unknown, csrf?: boolean): Promise<RawResponse>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

async function fakeDiscord(): Promise<string> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/api/oauth2/token") {
        const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
        send(200, { access_token: `at-${form.code}` });
        return;
      }
      const code = (req.headers.authorization ?? "").replace(/^Bearer at-/, "");
      const user = USERS[code];
      if (!user) return send(401, {});
      send(200, { id: user[0], username: user[1], global_name: user[1], avatar: null });
    });
  });
  const port = await listenFetchable(server);
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${port}`;
}

/** Records every envelope on the bus: the page must not add to them. */
class Watcher implements Module {
  readonly manifest = defineManifest("watcher", "Watcher");
  constructor(private readonly seen: Envelope[]) {}
  async start(ctx: ModuleContext): Promise<void> {
    const sub = ctx.subscribe("*");
    ctx.spawn("watch", async () => {
      for await (const env of sub) this.seen.push(env);
    });
  }
}

async function rig(publicConfig: Record<string, JsonValue> = {}, panelDir = ""): Promise<Rig> {
  const discordUrl = await fakeDiscord();
  const sup = new Supervisor();
  const store = new TestStore();
  const s = sup.services;
  const k = "kernel";
  s.provide(k, SupervisorKey, sup);
  s.provide(k, ActiveProfileKey, "p");
  s.provide(k, AuthStoreKey, store.auth);
  s.provide(k, AuditLogKey, store.audit);
  s.provide(k, SettingsStoreKey, store.settings);
  s.provide(k, PeopleStoreKey, store.people);
  s.provide("cards", MemberCardStoreKey, store.cards);
  // Alice wrote twice today and spoke once yesterday; Bob's line is not hers to see.
  s.provide(k, MessageLogKey, {
    authoredSince: async (profile: string, authors: AccountRef[]) => {
      if (profile !== "p" || !authors.some((a) => a.id === ALICE)) return [];
      const now = Date.now();
      return [
        { ts: new Date(now - 86_400_000).toISOString(), kind: "voice" },
        { ts: new Date(now).toISOString(), kind: "channel" },
        { ts: new Date(now).toISOString(), kind: "dm" },
      ];
    },
  } as never);
  const auth = await AuthService.load(store.auth, store.audit, [discord(OWNER)], "user");
  s.provide("auth", AuthServiceKey, auth);
  s.provide("auth", AuthorizerKey, auth);
  await auth.assign("test", discord(ERIN), "blocked", { type: "global" });

  const people = new Map<string, PersonId>();
  for (const id of [OWNER, ALICE, BOB, CAROL, ERIN, FRANK]) {
    const name = Object.values(USERS).find(([uid]) => uid === id)?.[1] ?? id;
    people.set(id, await store.people.upsertAccount(discord(id), name));
  }
  const alice = people.get(ALICE) as PersonId;
  const bob = people.get(BOB) as PersonId;
  const carol = people.get(CAROL) as PersonId;
  const erin = people.get(ERIN) as PersonId;
  const frank = people.get(FRANK) as PersonId;

  const cards = new Map<PersonId, PersonCard>([
    [alice, card(alice, "Alice", { call_name: "小愛", public_feeling: "妳總是記得跟我打招呼。" })],
    [bob, card(bob, "Bob", { public_feeling: "SECRET-bob-line" })],
    [carol, card(carol, "Carol", { public_feeling: "SECRET-carol-line" })],
    [erin, card(erin, "Erin", { public_feeling: "SECRET-erin-line" })],
    [frank, card(frank, "Frank", { blocked: true, public_feeling: "SECRET-frank-line" })],
  ]);
  const bonds: Rig["bonds"] = [];
  s.provide("self", AffectStateKey, {
    card: (p: PersonId) => cards.get(p) ?? null,
    cards: () => [...cards.values()],
    adjustBond: async (person: PersonId, change: BondChange) => {
      bonds.push({ person, change });
      return cards.get(person) ?? null;
    },
  } as unknown as AffectState);
  s.provide("social", SocialSignalsKey, {
    attitude: (a: AccountRef) =>
      a.id === CAROL ? ({ blocked: true } as never) : ({ blocked: false } as never),
  });

  const songs = [
    song(1, { state: "done" }),
    song(2, { state: "playing" }),
    song(3, { state: "ready" }),
    song(4, { state: "preparing", song: null }),
    song(5, { state: "ready", requester: discord(ALICE), query: "Alice 自己打的字" }),
    song(6, { state: "failed", error: "SECRET-failure" }),
  ];
  const counters = { songs: 0, activity: 0 };
  s.provide("sing", SingerKey, {
    playing: () => songs.find((e) => e.state === "playing") ?? null,
    list: {
      all: () => {
        counters.songs += 1;
        return songs;
      },
    },
  } as never);
  const snapshot: ActivitySnapshot = {
    version: 7,
    at: AT,
    presence: { type: "in", channel: GUILD, since: AT },
    broadcast: {
      type: "live",
      guild: "SECRET-guild",
      golive: true,
      obs: true,
      task: null,
      since: AT,
    },
    activity: {
      type: "game",
      target: "minecraft",
      phase: "running",
      task: "SECRET-task" as never,
      failure: null,
      since: AT,
    },
    override: { scene: "SECRET-scene", until: AT, by: "SECRET-by" },
    scene: "SECRET-scene",
  };
  s.provide("activity", ActivityManagerKey, {
    snapshot: () => {
      counters.activity += 1;
      return snapshot;
    },
  } as never);
  s.provide("moderation", ModerationKey, {
    filteredLine: "[filtered]",
    filteredVoiceLine: "",
    screen: (c: { visible?: string | null }) => {
      const blocked = /BADWORD/.test(c.visible ?? "");
      return { ok: !blocked, visible: c.visible, voice: null, blocked: blocked ? [{}] : [] };
    },
    inspect: (i: { text: string }) => ({
      action: /ignore previous/i.test(i.text) ? "mark" : "pass",
      flags: [],
      reasons: [],
      untrusted: true,
      note: null,
      retry_after_ms: null,
      owner: false,
    }),
  } as never);

  const memories = new Map<PersonId, MemoryRecord[]>([
    [
      alice,
      [
        memory("m1", { content: "Alice 第一次來語音陪她聊天", subjects: [alice] }),
        memory("m2", { kind: "fact", content: "小愛喜歡貓", subjects: [alice] }),
        memory("m3", { content: "Alice 和 Bob 一起打遊戲", subjects: [alice, bob] }),
        memory("m4", {
          content: "聽說 Alice 考試沒過",
          subjects: [alice],
          origin: "told",
          source: { account: discord(BOB), name: "SECRET-teller" },
        }),
        memory("m5", {
          content: "有人私下說了 Alice 的事",
          subjects: [alice],
          scope: { type: "dm", account: discord(BOB) },
        }),
        memory("m6", { kind: "self_note", content: "SECRET-inner note", subjects: [alice] }),
        memory("m7", {
          content: "群組私訊裡提到 Alice",
          subjects: [alice],
          scope: { type: "channel", context: { ...GUILD, scope: null, kind: "dm" } },
        }),
        memory("m8", { content: "Alice 說了 BADWORD", subjects: [alice] }),
        memory("m9", {
          content: "Alice 私下告訴她想學吉他",
          subjects: [alice],
          scope: { type: "dm", account: discord(ALICE) },
        }),
      ],
    ],
    [bob, [memory("b1", { content: "SECRET-bob-memory", subjects: [bob] })]],
    [carol, [memory("c1", { content: "SECRET-carol-memory", subjects: [carol] })]],
  ]);
  const derived = [memory("d1", { kind: "fact", content: "Alice 教她的冷知識" })];
  const forgotten: Rig["forgotten"] = [];
  s.provide("memory", MemoryEngineKey, {
    personOf: async (a: AccountRef) => people.get(a.id) ?? null,
    memoriesOf: async (p: PersonId | null) => (p === null ? [] : (memories.get(p) ?? [])),
    derivedFrom: async (p: PersonId | null) => ({
      records: p === alice ? derived : [],
      unverified: 0,
    }),
    forget: async (person: PersonId | null, account: AccountRef) => {
      forgotten.push({ person, account });
      return { deleted: 3, about: 2, derived: 1, unverified: 1 };
    },
  } as never);

  const registry = new ActuatorRegistry({ services: s, builtins: false });
  s.provide("app", ActuatorRegistryKey, registry);
  const requested: Rig["requested"] = [];
  const rule = { deny: null as string | null };
  s.provide("directive", DirectivesKey, {
    check: async () =>
      rule.deny === null
        ? { outcome: "allow", directive: null, reason: "" }
        : { outcome: "deny", directive: null, reason: rule.deny },
  } as never);
  registry.register(
    defineCapability<unknown>({
      name: "sing.request",
      summary: "song",
      risk: "medium",
      args: z.object({ query: z.string(), by: z.string().nullish() }),
      permission: "queue.song.request",
      limits: { per_day: 40, per_person_per_day: 2, cooldown_ms: 0 },
      async execute(args, ctx) {
        requested.push({
          args,
          kind: ctx.principal.kind,
          requester: ctx.principal.requester,
        });
        if ((args as { query: string }).query === "worker down") {
          throw new Error("SECRET connect ECONNREFUSED 127.0.0.1:8005");
        }
        return "SECRET-result text";
      },
    }),
  );

  const bus: Envelope[] = [];
  await sup.register(new Watcher(bus), {}, true);
  const dice = { value: 0 };
  const api = new ApiModule({ env: () => undefined, random: () => dice.value });
  await sup.register(
    api,
    {
      bind: "127.0.0.1:0",
      token: TOKEN,
      panel_dir: panelDir,
      discord_oauth: {
        client_id: "cid",
        client_secret: "secret",
        redirect_uri: REDIRECT,
        recheck_secs: 0,
        discord_url: discordUrl,
      },
      public: publicConfig,
    },
    true,
  );
  await sup.startAll();
  cleanups.push(() => sup.stopAll());
  const base = api.url() ?? "";

  const loginResult = async (code: string) => {
    const start = await fetch(`${base}/api/auth/oauth/login`, { redirect: "manual" });
    await start.arrayBuffer();
    const authorize = new URL(start.headers.get("location") ?? "");
    const url = new URL(`${base}/api/auth/oauth/callback`);
    url.searchParams.append("code", code);
    url.searchParams.append("state", authorize.searchParams.get("state") ?? "");
    const done = await fetch(url, { redirect: "manual" });
    await done.arrayBuffer();
    const set = done.headers.get("set-cookie");
    return {
      location: done.headers.get("location") ?? "",
      cookie: set === null ? null : (set.split(";")[0] ?? "").slice("miyoria_session=".length),
    };
  };
  return {
    sup,
    base,
    store,
    auth,
    people,
    cards,
    songs,
    memories,
    derived,
    forgotten,
    bonds,
    requested,
    bus,
    counters,
    rule,
    dice,
    loginResult,
    login: async (code) => {
      const { cookie } = await loginResult(code);
      if (cookie === null) throw new Error(`${code} did not get a session`);
      return cookie;
    },
    get: (path, cookie, headers = {}) =>
      raw(base, "GET", path, {
        headers: { ...headers, ...(cookie ? { cookie: `miyoria_session=${cookie}` } : {}) },
      }),
    post: (path, cookie, json = {}, csrf = true) =>
      raw(base, "POST", path, {
        json,
        headers: {
          cookie: `miyoria_session=${cookie}`,
          ...(csrf ? { "x-miyoria-request": "1" } : {}),
        },
      }),
  };
}

/** Every route of the app, from the same list the server is built from. */
function allRoutes(publicEnabled = true) {
  const ctx = { clock: { now: () => 0 }, services: { get: () => undefined } };
  const side = new PublicSide(PublicConfigSchema.parse({ enabled: publicEnabled }), () => 0);
  const state = new ApiState(
    ctx as never,
    {} as never,
    new Monitor(),
    null,
    () => [],
    [],
    undefined,
    undefined,
    undefined,
    side,
  );
  return routes(state);
}

const concrete = (path: string) => path.replace(/:[A-Za-z_]+/g, "x");

/** Every key path of a JSON value, arrays as `[]`: what a response's shape is. */
function shape(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap((v) => shape(v, `${at}[]`)))].sort();
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .flatMap(([k, v]) => shape(v, at === "" ? k : `${at}.${k}`))
      .sort();
  }
  return [at];
}

const STATUS_SHAPE = [
  "days[].date",
  "days[].hours_in_voice",
  "days[].hours_live",
  "days[].songs_sung",
  "game",
  "in_voice",
  "live",
  "state",
  "today.hours_in_voice",
  "today.hours_live",
  "today.songs_sung",
];
const SONGS_SHAPE = [
  "playing.artist",
  "playing.duration_s",
  "playing.title",
  "recent[].artist",
  "recent[].duration_s",
  "recent[].title",
  "upcoming[].artist",
  "upcoming[].duration_s",
  "upcoming[].ready",
  "upcoming[].title",
];
const ME_SHAPE = [
  "activity[].date",
  "activity[].text",
  "activity[].voice",
  "can_request_song",
  "card.affinity",
  "card.call_name",
  "card.familiarity",
  "card.public_feeling",
  "card.relationship",
  "card.trust",
  "forget.keeps",
  "forget.removes",
  "memories[].date",
  "memories[].kind",
  "memories[].text",
  "songs[].artist",
  "songs[].requested_at",
  "songs[].state",
  "songs[].title",
];

describe("the route table", () => {
  it("lists exactly these routes as open to non-admins", () => {
    const line = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
    const all = allRoutes();
    expect(
      all
        .filter((r) => r.public)
        .map(line)
        .sort(),
    ).toEqual([
      "GET /api/auth/methods",
      "GET /api/auth/oauth/callback",
      "GET /api/auth/oauth/login",
      "GET /api/health",
      "GET /api/public/board",
      "GET /api/public/card/:serial",
      "GET /api/public/live",
      "GET /api/public/live/video/:file",
      "GET /api/public/songs",
      "GET /api/public/status",
      "GET /og/card/:file",
      "GET /og/default.png",
      "POST /api/auth/logout",
    ]);
    expect(
      all
        .filter((r) => r.member)
        .map(line)
        .sort(),
    ).toEqual([
      "GET /api/member/bounties",
      "GET /api/member/card",
      "GET /api/member/export",
      "GET /api/member/fortune",
      "GET /api/member/goals",
      "GET /api/member/me",
      "GET /api/member/session",
      "GET /api/member/wallet",
      "POST /api/member/board",
      "POST /api/member/card",
      "POST /api/member/card/reroll",
      "POST /api/member/checkin",
      "POST /api/member/expression",
      "POST /api/member/feed",
      "POST /api/member/forget",
      "POST /api/member/fortune",
      "POST /api/member/frame",
      "POST /api/member/goals/:id/pledge",
      "POST /api/member/letter",
      "POST /api/member/live/pat",
      "POST /api/member/screen",
      "POST /api/member/songs",
      "POST /api/member/transfer",
    ]);
    expect(all.filter((r) => !r.public && !r.member).length).toBeGreaterThan(90);
    // No member route takes a parameter that could name a person (a goal is not one).
    expect(
      all.filter(
        (r) => r.member && r.path.includes(":") && !r.path.startsWith("/api/member/goals/"),
      ),
    ).toEqual([]);
  });

  it("drops the public and member routes when switched off", () => {
    const paths = allRoutes(false).map((r) => r.path);
    expect(paths.filter((p) => /^\/api\/(public|member)\//.test(p))).toEqual([]);
  });
});

describe("admin routes", () => {
  it("answer 401 to anonymous requests, every one of them", async () => {
    const r = await rig();
    for (const route of allRoutes().filter((x) => !x.public && !x.member)) {
      const res = await raw(r.base, route.method, concrete(route.path), {
        headers: { "x-miyoria-request": "1" },
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
    }
  }, 60_000);

  it("answer 401 to a member session, every one of them", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    for (const route of allRoutes().filter((x) => !x.public && !x.member)) {
      const res = await raw(r.base, route.method, concrete(route.path), {
        headers: { cookie: `miyoria_session=${cookie}`, "x-miyoria-request": "1" },
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
    }
  }, 60_000);

  it("still open to an admin session and the token", async () => {
    const r = await rig();
    const cookie = await r.login("owner");
    expect((await r.get("/api/auth/session", cookie)).status).toBe(200);
    const token = await raw(r.base, "GET", "/api/auth/session", { token: TOKEN });
    expect(token.status).toBe(200);
  });
});

describe("the session model", () => {
  it("gives a login without panel access a member session, not a refusal", async () => {
    const r = await rig();
    const { location, cookie } = await r.loginResult("alice");
    expect(location).toBe("/");
    expect(cookie).not.toBeNull();
    const stored = [...(await r.store.settings.list("_global", "panel_session:")).values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ tier: "member" });
    expect((await r.get("/api/member/session", cookie ?? "")).body).toEqual({
      name: "Alice",
      avatar_url: expect.stringContaining("cdn.discordapp.com"),
    });
    const audit = await r.store.audit.recent(10, `discord:${ALICE}`);
    expect(audit.map((a) => a.action)).toContain("member.login");
  });

  it("does not turn a member session into an admin one when the account gains access", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    await r.auth.assign("test", discord(ALICE), "admin", { type: "global" });
    expect((await r.get("/api/auth/session", cookie)).status).toBe(401);
    const fresh = await r.login("alice");
    expect((await r.get("/api/auth/session", fresh)).status).toBe(200);
  });

  it("keeps the tier across a restart, and old records stay admin but re-checked", async () => {
    const store = new MemorySettingsStore();
    const clock = { now: () => Date.parse(AT) };
    const a = new Sessions(86_400_000, 0, clock);
    const token = await a.create(store, discord(ALICE), "Alice", null, "member");
    const b = new Sessions(86_400_000, 0, clock);
    expect((await b.lookup(store, undefined, token))?.record.tier).toBe("member");

    const [[key, value] = ["", null]] = [...(await store.list("_global", "panel_session:"))];
    const { tier: _dropped, ...old } = value as Record<string, JsonValue>;
    await store.set("_global", key, old);
    const c = new Sessions(86_400_000, 0, clock);
    const found = await c.lookup(store, undefined, token);
    expect(found?.record.tier).toBe("admin");
    expect(found?.access.panel).toBe(false);
  });

  it("leaves an admin who lost access with the member routes only", async () => {
    const r = await rig();
    await r.auth.assign("test", discord(BOB), "admin", { type: "global" });
    const cookie = await r.login("bob");
    expect((await r.get("/api/auth/session", cookie)).status).toBe(200);
    await r.auth.revoke("test", discord(BOB), "admin", { type: "global" });
    expect((await r.get("/api/auth/session", cookie)).status).toBe(401);
    expect((await r.get("/api/member/session", cookie)).status).toBe(200);
  });

  it("is not opened by the admin token, and refuses changes without the CSRF header", async () => {
    const r = await rig();
    const token = await raw(r.base, "GET", "/api/member/me", { token: TOKEN });
    expect(token.status).toBe(401);
    expect((await r.get("/api/member/me")).status).toBe(401);
    const cookie = await r.login("alice");
    const res = await r.post("/api/member/forget", cookie, { confirm: true }, false);
    expect(res.status).toBe(403);
    expect(r.forgotten).toEqual([]);
  });

  it("ends with logout", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    await r.post("/api/auth/logout", cookie);
    expect((await r.get("/api/member/me", cookie)).status).toBe(401);
  });
});

describe("the public view", () => {
  it("answers anonymously with exactly the allowed fields", async () => {
    const r = await rig();
    const status = await r.get("/api/public/status");
    expect(status.status).toBe(200);
    expect(shape(status.body)).toEqual(STATUS_SHAPE);
    expect(status.body).toEqual({
      state: "singing",
      live: true,
      in_voice: true,
      game: "minecraft",
      today: { songs_sung: 0, hours_live: 0, hours_in_voice: 0 },
      days: (status.body as { days: unknown[] }).days,
    });
    expect((status.body as { days: unknown[] }).days).toHaveLength(PUBLIC_DAYS);
    const songs = await r.get("/api/public/songs");
    expect(shape(songs.body)).toEqual(SONGS_SHAPE);
    expect(songs.body).toEqual({
      playing: { title: "Title 2", artist: "Artist", duration_s: 200 },
      upcoming: [
        { title: "Title 3", artist: "Artist", duration_s: 200, ready: true },
        { title: null, artist: null, duration_s: null, ready: false },
        { title: "Title 5", artist: "Artist", duration_s: 200, ready: true },
      ],
      recent: [{ title: "Title 1", artist: "Artist", duration_s: 200 }],
    });
  });

  it("holds nothing internal, nobody's id and nobody's name", async () => {
    const r = await rig();
    for (const path of ["/api/public/status", "/api/public/songs"]) {
      const { text, headers } = await r.get(path);
      expect(text).not.toContain("SECRET");
      for (const [id, name] of Object.values(USERS)) {
        expect(text).not.toContain(id);
        expect(text).not.toContain(name);
      }
      expect(headers.get("set-cookie")).toBeNull();
    }
  });

  it("walks through what she may be doing", async () => {
    const side = (over: Partial<ActivitySnapshot>, playing = false) => {
      const snapshot = { presence: { type: "none" }, broadcast: { type: "off" }, ...over };
      const services = new Map<unknown, unknown>([
        [ActivityManagerKey, { snapshot: () => ({ activity: { type: "idle" }, ...snapshot }) }],
        [SingerKey, { playing: () => (playing ? song(1) : null) }],
      ]);
      return services;
    };
    const { publicStatus } = await import("../src/public.js");
    const stateOf = (services: Map<unknown, unknown> | null) =>
      publicStatus({
        optional: (key: unknown) => services?.get(key),
        publicSide: new PublicSide(PublicConfigSchema.parse({}), () => 0),
        now: () => 0,
      } as never).state;
    expect(stateOf(null)).toBe("offline");
    expect(stateOf(side({}))).toBe("idle");
    const voice = { presence: { type: "in", channel: GUILD, since: AT } } as const;
    expect(stateOf(side(voice))).toBe("in_voice");
    const live = {
      ...voice,
      broadcast: { type: "live", guild: "g", golive: true, obs: true, task: null, since: AT },
    } as const;
    expect(stateOf(side(live))).toBe("live");
    const game = {
      ...live,
      activity: {
        type: "game",
        target: "minecraft",
        phase: "running",
        task: null,
        failure: null,
        since: AT,
      },
    } as const;
    expect(stateOf(side(game))).toBe("playing");
    expect(stateOf(side(game, true))).toBe("singing");
  });

  it("leaves out a title moderation does not pass, and a strange game id", async () => {
    const r = await rig();
    const entry = r.songs[0] as SongEntry;
    if (entry.song) entry.song.title = "BADWORD song";
    const songs = await r.get("/api/public/songs");
    expect(songs.text).not.toContain("BADWORD");
    expect((songs.body as { recent: { title: unknown }[] }).recent[0]?.title).toBeNull();
  });

  it("shows no title at all without moderation", async () => {
    const r = await rig();
    r.sup.services.removeOwnedBy("moderation");
    const songs = (await r.get("/api/public/songs")).body as { recent: { title: unknown }[] };
    expect(songs.recent[0]?.title).toBeNull();
  });

  it("serves many visitors from one build, and says so to caches", async () => {
    const r = await rig();
    const first = await r.get("/api/public/status");
    expect(first.headers.get("cache-control")).toBe("public, max-age=10");
    const before = { ...r.counters };
    for (let i = 0; i < 20; i++) {
      await r.get("/api/public/status");
      await r.get("/api/public/songs");
    }
    expect(r.counters.activity).toBe(before.activity);
    expect(r.counters.songs).toBe(before.songs + 1);
  });

  it("is the same for everyone: a session changes nothing about it", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const anonymous = await r.get("/api/public/songs");
    const logged = await r.get("/api/public/songs", cookie);
    expect(logged.text).toBe(anonymous.text);
  });

  it("puts nothing on the bus, so being looked at cannot reach her", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = r.bus.length;
    await r.get("/api/public/status");
    await r.get("/api/public/songs");
    await r.get("/api/member/me", cookie);
    await r.get("/api/member/session", cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.bus.slice(before)).toEqual([]);
  });

  it("goes away with the switch, leaving the old login behaviour", async () => {
    const r = await rig({ enabled: false });
    expect((await r.get("/api/public/status")).body).toEqual({ error: "no such endpoint" });
    const { location, cookie } = await r.loginResult("alice");
    expect(location).toBe("/login?error=denied");
    expect(cookie).toBeNull();
    const admin = await r.login("owner");
    expect((await r.get("/api/member/me", admin)).status).toBe(404);
  });
});

describe("rate limits", () => {
  it("answers 429 with Retry-After once a client asks too much", async () => {
    const r = await rig({ rate_per_minute: 3 });
    const h = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 3; i++) {
      expect((await r.get("/api/public/status", undefined, h)).status).toBe(200);
    }
    const res = await r.get("/api/public/status", undefined, h);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Behind the tunnel everyone comes from 127.0.0.1: the limit is per visitor, not for all.
    const other = await r.get("/api/public/status", undefined, {
      "cf-connecting-ip": "203.0.113.8",
    });
    expect(other.status).toBe(200);
  });

  it("holds a limit for everyone together, whatever address they claim", async () => {
    const r = await rig({ rate_total_per_minute: 4 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await r.get("/api/public/songs", undefined, {
        "cf-connecting-ip": `198.51.100.${i}`,
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
  });

  it("trusts CF-Connecting-IP only from this machine", () => {
    const ctx = (peer: string | undefined, header: string | undefined) =>
      ({
        env: peer === undefined ? undefined : { incoming: { socket: { remoteAddress: peer } } },
        req: { header: () => header },
      }) as never;
    expect(clientKey(ctx("127.0.0.1", "203.0.113.7"))).toBe("203.0.113.7");
    expect(clientKey(ctx("::ffff:127.0.0.1", "203.0.113.7"))).toBe("203.0.113.7");
    expect(clientKey(ctx("198.51.100.9", "203.0.113.7"))).toBe("198.51.100.9");
    expect(clientKey(ctx("127.0.0.1", undefined))).toBe("local");
    // One IPv6 client holds a /64.
    expect(clientKey(ctx("127.0.0.1", "2001:db8:1:2:3:4:5:6"))).toBe(
      clientKey(ctx("127.0.0.1", "2001:db8:1:2:aaaa:bbbb:cccc:dddd")),
    );
  });

  it("does not grow without bound when addresses keep changing", () => {
    const limit = new RateWindow(1, 60_000, 100);
    for (let i = 0; i < 1000; i++) limit.hit(`client-${i}`, 0);
    expect(limit.hit("client-999", 1)).not.toBeNull();
    expect(limit.hit("client-0", 1)).toBeNull();
    expect(limit.hit("late", 61_000)).toBeNull();
  });

  it("limits logins per client, and heavy member routes per person", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await r.get("/api/member/export", cookie)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
    const logins: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await raw(r.base, "GET", "/api/auth/oauth/login", {
        headers: { "cf-connecting-ip": "203.0.113.50" },
      });
      logins.push(res.status);
    }
    expect(logins.at(-1)).toBe(429);
    expect(logins.at(0)).toBe(302);
  });
});

describe("today's numbers", () => {
  const T = Date.parse("2026-11-07T01:00:00.000Z");
  const ended = (outcome: string): Envelope =>
    newEnvelope("sing", customEvent(SONG_TOPIC, { state: "ended", song: "s", outcome }));

  it("counts songs sung to the end and hours in tenths", () => {
    const stats = new PublicStats(480, T);
    stats.handle(ended("finished"), T);
    stats.handle(ended("interrupted"), T);
    stats.sample(T, { live: true, inVoice: true });
    for (let i = 1; i <= 90; i++) {
      stats.sample(T + i * 60_000, { live: true, inVoice: i <= 30 });
    }
    expect(stats.view(T + 90 * 60_000)).toEqual({
      songs_sung: 1,
      hours_live: 1.5,
      hours_in_voice: 0.5,
    });
  });

  it("starts over at local midnight, and does not count time the Core was down", () => {
    const stats = new PublicStats(480, T);
    stats.sample(T, { live: true, inVoice: true });
    stats.sample(T + 3 * 3_600_000, { live: true, inVoice: true });
    expect(stats.view(T + 3 * 3_600_000).hours_live).toBeLessThan(0.1);
    stats.handle(ended("finished"), T);
    const tomorrow = Date.parse("2026-11-07T16:00:00.000Z");
    expect(stats.view(tomorrow).songs_sung).toBe(0);
  });

  it("survives a restart on the same day only", async () => {
    const store = new MemorySettingsStore();
    const stats = new PublicStats(480, T);
    stats.handle(ended("finished"), T);
    await stats.save(store);
    expect(await store.get("_global", PUBLIC_STATS_KEY)).toMatchObject({ songs: 1 });
    const again = new PublicStats(480, T);
    await again.load(store, T);
    expect(again.view(T).songs_sung).toBe(1);
    const nextDay = T + 86_400_000;
    const later = new PublicStats(480, nextDay);
    await later.load(store, nextDay);
    expect(later.view(nextDay).songs_sung).toBe(0);
    // The day that ended while it was down is yesterday's column.
    const days = later.days(nextDay);
    expect(days.at(-2)).toMatchObject({ date: "2026-11-07", songs_sung: 1 });
    expect(days.at(-1)).toMatchObject({ date: "2026-11-08", songs_sung: 0 });
  });

  it("keeps a column per local day, oldest first, across midnight and restarts", async () => {
    const store = new MemorySettingsStore();
    const stats = new PublicStats(480, T);
    stats.handle(ended("finished"), T);
    stats.handle(ended("finished"), T);
    const tomorrow = T + 86_400_000;
    stats.handle(ended("finished"), tomorrow);
    await stats.save(store);
    const again = new PublicStats(480, tomorrow);
    await again.load(store, tomorrow);
    const days = again.days(tomorrow);
    expect(days).toHaveLength(PUBLIC_DAYS);
    expect(days.map((d) => d.songs_sung).slice(-3)).toEqual([0, 2, 1]);
    expect(days[0]?.date).toBe("2026-10-26");
    // A month later the old days are gone.
    const later = T + 40 * 86_400_000;
    expect(again.days(later).every((d) => d.songs_sung === 0)).toBe(true);
  });
});

describe("the member view", () => {
  it("shows exactly the allowed fields, in words", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const res = await r.get("/api/member/me", cookie);
    expect(res.status).toBe(200);
    expect(shape(res.body)).toEqual(ME_SHAPE);
    const body = res.body as Record<string, never>;
    expect(body.card).toEqual({
      call_name: "小愛",
      relationship: "好朋友",
      affinity: "很好",
      trust: "信任",
      familiarity: "熟",
      public_feeling: "妳總是記得跟我打招呼。",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("charts their own lines per day, text and voice apart", async () => {
    const r = await rig();
    const alice = (await r.get("/api/member/me", await r.login("alice"))).body as {
      activity: { date: string; text: number; voice: number }[];
    };
    expect(alice.activity).toHaveLength(30);
    expect(alice.activity.at(-1)).toMatchObject({ text: 2, voice: 0 });
    expect(alice.activity.at(-2)).toMatchObject({ text: 0, voice: 1 });
    const bob = (await r.get("/api/member/me", await r.login("bob"))).body as {
      activity: { text: number; voice: number }[];
    };
    expect(bob.activity.every((d) => d.text === 0 && d.voice === 0)).toBe(true);
  });

  it("never sends a number of hers, or her private feeling", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const { text } = await r.get("/api/member/me", cookie);
    expect(text).not.toContain("SECRET");
    expect(text).not.toMatch(/"(affinity|trust|familiarity)":\s*-?\d/);
    expect(text).not.toContain("attachment");
    expect(text).not.toContain("blocked");
    expect(text).not.toContain("owner");
  });

  it("bands every value into a word", () => {
    for (let v = -100; v <= 100; v += 1) {
      expect(affinityBand(v)).toMatch(/^\D+$/);
      if (v >= 0) {
        expect(trustBand(v)).toMatch(/^\D+$/);
        expect(familiarityBand(v)).toMatch(/^\D+$/);
      }
    }
  });

  it("shows only memories that are theirs to read", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const body = (await r.get("/api/member/me", cookie)).body as {
      memories: { text: string }[];
    };
    expect(body.memories.map((m) => m.text)).toEqual([
      "Alice 私下告訴她想學吉他",
      "小愛喜歡貓",
      "Alice 第一次來語音陪她聊天",
    ]);
  });

  it("lists their own song requests and nobody else's", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const body = (await r.get("/api/member/me", cookie)).body as { songs: unknown[] };
    expect(body.songs).toEqual([
      { title: "Title 5", artist: "Artist", state: "ready", requested_at: AT },
    ]);
  });

  it("gives someone she never met the same page with nothing on it", async () => {
    const r = await rig();
    const cookie = await r.login("dave");
    const res = await r.get("/api/member/me", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      card: {
        call_name: null,
        relationship: null,
        affinity: null,
        trust: null,
        familiarity: null,
        public_feeling: null,
      },
      memories: [],
      songs: [],
      can_request_song: false,
    });
  });
});

describe("reading someone else", () => {
  const ATTEMPTS = [
    "?person=BOB",
    "?id=BOB",
    "?person_id=BOB",
    "?account=discord:333",
    "?discord_id=333",
    "?user=333",
    "?handle=Bob",
    "?name=Bob",
    "?as=BOB",
  ];

  it("gets nowhere with any query parameter", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const mine = (await r.get("/api/member/me", cookie)).text;
    const bob = r.people.get(BOB) as string;
    for (const attempt of ATTEMPTS) {
      const res = await r.get(`/api/member/me${attempt.replace("BOB", bob)}`, cookie);
      expect(res.status, attempt).toBe(200);
      expect(res.text, attempt).toBe(mine);
    }
  });

  it("gets nowhere with headers or a path", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const mine = (await r.get("/api/member/me", cookie)).text;
    const bob = r.people.get(BOB) as string;
    const headers = { "x-person": bob, "x-account": `discord:${BOB}`, "x-user-id": BOB };
    expect((await r.get("/api/member/me", cookie, headers)).text).toBe(mine);
    expect((await r.get(`/api/member/me/${bob}`, cookie)).status).toBe(404);
    expect((await r.get(`/api/member/${bob}`, cookie)).status).toBe(404);
    expect((await r.get(`/api/member/${BOB}/export`, cookie)).status).toBe(404);
  });

  it("gets nowhere with the export", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const { text } = await r.get(`/api/member/export?person=${r.people.get(BOB)}`, cookie);
    expect(text).not.toContain("SECRET");
    expect(text).toContain("Alice");
    expect(text).not.toContain("Bob");
  });

  it("cannot forget anyone else: unknown body fields are refused", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const bob = r.people.get(BOB);
    for (const json of [
      { confirm: true, person: bob },
      { confirm: true, account: { platform: "discord", id: BOB } },
      { confirm: true, keyword: "x" },
    ]) {
      expect((await r.post("/api/member/forget", cookie, json)).status).toBe(422);
    }
    expect(r.forgotten).toEqual([]);
  });

  it("cannot request a song as someone else", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const res = await r.post("/api/member/songs", cookie, { query: "x", by: "Bob", key: 3 });
    expect(res.status).toBe(422);
    expect(r.requested).toEqual([]);
  });

  it("stays out of a shared cache", async () => {
    const r = await rig();
    const a = await r.login("alice");
    const b = await r.login("bob");
    const alice = await r.get("/api/member/me", a);
    const bob = await r.get("/api/member/me", b);
    expect(alice.text).not.toBe(bob.text);
    expect(bob.text).not.toContain("小愛");
    for (const path of ["session", "me", "export"]) {
      expect((await r.get(`/api/member/${path}`, a)).headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("public_feeling on the page", () => {
  it("shows nothing rather than her private feeling when there is none", async () => {
    const r = await rig();
    const alice = r.people.get(ALICE) as PersonId;
    const c = r.cards.get(alice) as PersonCard;
    // Names nobody else, so only the rule itself can keep it off the page, not the name filter.
    r.cards.set(alice, { ...c, public_feeling: null, feeling: "SECRET-feeling 我有點在意她" });
    const cookie = await r.login("alice");
    const res = await r.get("/api/member/me", cookie);
    expect((res.body as { card: Record<string, unknown> }).card.public_feeling).toBeNull();
    expect(res.text).not.toContain("SECRET-feeling");
    expect((await r.get("/api/member/export", cookie)).text).not.toContain("SECRET-feeling");
  });

  it("drops a stored line that names someone else, even one who came along later", async () => {
    const r = await rig();
    const alice = r.people.get(ALICE) as PersonId;
    const c = r.cards.get(alice) as PersonCard;
    r.cards.set(alice, { ...c, public_feeling: "妳和 Bob 感情真好。" });
    const cookie = await r.login("alice");
    const body = (await r.get("/api/member/me", cookie)).body as {
      card: Record<string, unknown>;
    };
    expect(body.card.public_feeling).toBeNull();
    // Written spaced and in another case it is still the name.
    r.cards.set(alice, { ...c, public_feeling: "妳和 B O B 感情真好。" });
    const again = (await r.get("/api/member/me", cookie)).body as typeof body;
    expect(again.card.public_feeling).toBeNull();
  });

  it("drops a line moderation does not pass", async () => {
    const r = await rig();
    const alice = r.people.get(ALICE) as PersonId;
    const c = r.cards.get(alice) as PersonCard;
    r.cards.set(alice, { ...c, public_feeling: "BADWORD" });
    const cookie = await r.login("alice");
    const body = (await r.get("/api/member/me", cookie)).body as {
      card: Record<string, unknown>;
    };
    expect(body.card.public_feeling).toBeNull();
  });
});

describe("a blocked person", () => {
  const strip = (text: string) => {
    const { exported_at: _at, ...rest } = JSON.parse(text) as Record<string, unknown>;
    return rest;
  };

  it("logs in and sees exactly what a stranger sees, however they were blocked", async () => {
    const r = await rig();
    const stranger = await r.login("dave");
    const page = await r.get("/api/member/me", stranger);
    const file = await r.get("/api/member/export", stranger);
    const songRefusal = await r.post("/api/member/songs", stranger, { query: "song" });
    for (const code of ["carol", "erin", "frank"]) {
      const cookie = await r.login(code);
      const mine = await r.get("/api/member/me", cookie);
      expect(mine.status, code).toBe(200);
      expect(mine.text, code).toBe(page.text);
      expect(mine.text).not.toContain("SECRET");
      const download = await r.get("/api/member/export", cookie);
      expect(download.status, code).toBe(200);
      expect(strip(download.text), code).toEqual(strip(file.text));
      const song = await r.post("/api/member/songs", cookie, { query: "song" });
      expect(song.status, code).toBe(songRefusal.status);
      expect(song.text, code).toBe(songRefusal.text);
    }
    expect(r.requested).toEqual([]);
  });

  it("says nothing about being blocked anywhere", async () => {
    const r = await rig();
    const cookie = await r.login("carol");
    for (const path of ["session", "me", "export"]) {
      const { text } = await r.get(`/api/member/${path}`, cookie);
      expect(text).not.toMatch(/block|封鎖|ban/i);
    }
    expect((await r.get("/api/public/status", cookie)).status).toBe(200);
  });

  it("gets the answer of having nothing to forget, and nothing is touched", async () => {
    const r = await rig();
    const cookie = await r.login("carol");
    const res = await r.post("/api/member/forget", cookie, { confirm: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 0, about: 0, derived: 0, unverified: 0 });
    expect(r.forgotten).toEqual([]);
    expect(r.bonds).toEqual([]);
  });

  it("is treated as blocked when nothing can tell otherwise", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    r.sup.services.removeOwnedBy("self");
    r.sup.services.removeOwnedBy("social");
    const body = (await r.get("/api/member/me", cookie)).body as Record<string, unknown>;
    expect(body.memories).toEqual([]);
    expect(body.songs).toEqual([]);
    expect(body.can_request_song).toBe(false);
  });
});

describe("the export", () => {
  it("is a file of their own data, naming nobody else", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const res = await r.get("/api/member/export", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="miyoria-me-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(shape(res.body)).toEqual([
      "card.affinity",
      "card.call_name",
      "card.familiarity",
      "card.public_feeling",
      "card.relationship",
      "card.trust",
      "exported_at",
      "memories[].date",
      "memories[].derived_from_you",
      "memories[].kind",
      "memories[].text",
      "songs[].artist",
      "songs[].requested_at",
      "songs[].state",
      "songs[].title",
      "wallet.balance",
      "withheld",
    ]);
    expect(res.text).not.toContain("SECRET");
    const body = res.body as { memories: { text: string; derived_from_you: boolean }[] };
    expect(body.memories.find((m) => m.text === "Alice 教她的冷知識")?.derived_from_you).toBe(true);
    // m3 (Bob's name), m4 (Bob's words), m6 (her note), m8 (moderation).
    expect((res.body as { withheld: number }).withheld).toBe(4);
  });
});

describe("forgetting", () => {
  it("needs the confirmation", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    for (const json of [{}, { confirm: false }, { confirm: "true" }]) {
      expect((await r.post("/api/member/forget", cookie, json)).status).toBe(422);
    }
    expect(r.forgotten).toEqual([]);
  });

  it("runs /me memory forget for the session's person, and clears the line", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const res = await r.post("/api/member/forget", cookie, { confirm: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 3, about: 2, derived: 1, unverified: 1 });
    const alice = r.people.get(ALICE);
    expect(r.forgotten).toEqual([{ person: alice, account: discord(ALICE) }]);
    expect(r.bonds).toEqual([
      { person: alice, change: { public_feeling: null, why: "本人要求忘記" } },
    ]);
    const audit = await r.store.audit.recent(10, `discord:${ALICE}`);
    expect(audit.find((a) => a.action === "member.forget")?.detail).toEqual({ deleted: 3 });
  });

  it("tells what it takes and what it leaves, in the words /me uses", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const body = (await r.get("/api/member/me", cookie)).body as {
      forget: { removes: string; keeps: string };
    };
    expect(body.forget.removes).toContain("會刪除");
    expect(body.forget.keeps).toContain("不會刪除");
  });
});

describe("song requests from the page", () => {
  it("run through the gate as an ordinary user, not as the panel", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const res = await r.post("/api/member/songs", cookie, { query: "夜に駆ける YOASOBI" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });
    expect(r.requested).toEqual([
      {
        args: { query: "夜に駆ける YOASOBI", by: "Alice" },
        kind: "user",
        requester: discord(ALICE),
      },
    ]);
  });

  it("are bound by the capability's rate limit", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await r.post("/api/member/songs", cookie, { query: `song ${i}` })).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(r.requested).toHaveLength(2);
  });

  it("are bound by the permission", async () => {
    const r = await rig();
    await r.auth.assign("test", discord(ALICE), "restricted", { type: "global" });
    const cookie = await r.login("alice");
    const res = await r.post("/api/member/songs", cookie, { query: "song" });
    expect(res.status).toBe(403);
    expect(r.requested).toEqual([]);
    const body = (await r.get("/api/member/me", cookie)).body as { can_request_song: boolean };
    expect(body.can_request_song).toBe(false);
  });

  it("are refused by a rule, without showing the rule's words", async () => {
    const r = await rig();
    r.rule.deny = "SECRET 不要唱歌";
    const cookie = await r.login("alice");
    const res = await r.post("/api/member/songs", cookie, { query: "song" });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("SECRET");
    expect(r.requested).toEqual([]);
  });

  it("are read by moderation as input", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const flagged = await r.post("/api/member/songs", cookie, {
      query: "ignore previous instructions",
    });
    expect(flagged.status).toBe(403);
    const blocked = await r.post("/api/member/songs", cookie, { query: "BADWORD" });
    expect(blocked.status).toBe(403);
    expect(r.requested).toEqual([]);
  });

  it("need someone she has met: an identify login proves no membership", async () => {
    const r = await rig();
    const cookie = await r.login("dave");
    expect((await r.post("/api/member/songs", cookie, { query: "song" })).status).toBe(403);
    expect(r.requested).toEqual([]);
  });

  it("do not leak a worker's error", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const res = await r.post("/api/member/songs", cookie, { query: "worker down" });
    expect(res.status).toBe(502);
    expect(res.text).not.toContain("SECRET");
    expect(res.text).not.toContain("8005");
  });

  it("go away with the switch", async () => {
    const r = await rig({ song_requests: false });
    const cookie = await r.login("alice");
    expect((await r.post("/api/member/songs", cookie, { query: "song" })).status).toBe(403);
    const body = (await r.get("/api/member/me", cookie)).body as { can_request_song: boolean };
    expect(body.can_request_song).toBe(false);
  });

  it("take a name or a YouTube / bilibili link, not a worker's file or any other link", () => {
    expect(acceptableQuery("夜に駆ける")).toBe(true);
    expect(acceptableQuery("https://www.youtube.com/watch?v=x")).toBe(true);
    expect(acceptableQuery("唱這首 https://youtu.be/x")).toBe(true);
    expect(acceptableQuery("https://www.bilibili.com/video/BV1xx411c7mD")).toBe(true);
    expect(acceptableQuery("https://b23.tv/abc")).toBe(true);
    expect(acceptableQuery("https://bilibili.com.evil.test/x")).toBe(false);
    expect(acceptableQuery("library:secret.flac")).toBe(false);
    expect(acceptableQuery("  LIBRARY:../x")).toBe(false);
    expect(acceptableQuery("http://127.0.0.1:8005/x")).toBe(false);
    expect(acceptableQuery("https://youtube.com.evil.test/x")).toBe(false);
    expect(acceptableQuery("https://youtu.be/x https://evil.test/y")).toBe(false);
  });
});

describe("cards she gives", () => {
  const SERIAL = /^MYR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
  const CARD_SHAPE = [
    "affinity",
    "avatar_url",
    "call_name",
    "familiarity",
    "foil",
    "frame",
    "issued_at",
    "line",
    "name",
    "number",
    "pose",
    "public_feeling",
    "relationship",
    "serial",
    "stamp",
    "trust",
    "voided_at",
  ];
  type Card = Record<string, unknown> & { serial: string; pose: string; number: number };
  const issue = (r: Rig, cookie: string) => r.post("/api/member/card", cookie, {});
  const anyone = (r: Rig, serial: string) =>
    r.get(`/api/public/card/${serial}`, undefined, { "cf-connecting-ip": "203.0.113.20" });

  it("is what the member page shows them now, with a serial, a number and a pose", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const res = await issue(r, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(shape(res.body)).toEqual(CARD_SHAPE);
    const card = res.body as Card;
    expect(card.serial).toMatch(SERIAL);
    expect(Date.parse(card.issued_at as string)).not.toBeNaN();
    const me = (await r.get("/api/member/me", cookie)).body as { card: Record<string, unknown> };
    const session = (await r.get("/api/member/session", cookie)).body as Record<string, unknown>;
    expect(card).toMatchObject({ ...me.card, ...session, number: 1 });
    expect(card.affinity).toBe("很好");
    // The dice say the first pose of the band.
    expect(card.pose).toBe(CARD_POSES.很好?.[0]);
    expect(res.text).not.toContain("SECRET");
    expect(res.text).not.toMatch(/"(affinity|trust|familiarity)":\s*-?\d/);
    const audit = await r.store.audit.recent(10, `discord:${ALICE}`);
    expect(audit.find((a) => a.action === "member.card")?.detail).toEqual({ serial: card.serial });
  });

  it("picks the pose from the band's list", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const poses = new Set<string>();
    for (const value of [0, 0.5, 0.999]) {
      r.dice.value = value;
      poses.add(((await issue(r, cookie)).body as Card).pose);
    }
    expect([...poses].sort()).toEqual([...(CARD_POSES.很好 ?? [])].sort());
    const alice = r.people.get(ALICE) as PersonId;
    r.cards.set(alice, { ...(r.cards.get(alice) as PersonCard), affinity: -80 });
    const cold = (await issue(r, cookie)).body as Card;
    expect(cold.affinity).toBe("很差");
    expect(cold.pose).toBe("cold");
  });

  it("is listed as their latest, with how many they got today", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    expect((await r.get("/api/member/card", cookie)).body).toEqual({
      latest: null,
      today: 0,
      per_day: CARDS_PER_DAY,
      poses: (CARD_POSES.很好 ?? []).map((id) => ({ id, label: expect.any(String) })),
      prices: { pose: null, foil: null, reroll: null },
      rerolls_left: 0,
    });
    await issue(r, cookie);
    const second = (await issue(r, cookie)).body as Card;
    expect(second.number).toBe(2);
    const res = await r.get("/api/member/card", cookie);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toMatchObject({ latest: second, today: 2, per_day: CARDS_PER_DAY });
    // Bob has none of hers.
    const bob = await r.login("bob");
    expect((await r.get("/api/member/card", bob)).body).toMatchObject({ latest: null, today: 0 });
  });

  it("is given to a command through the Keepsakes service by the same rules", async () => {
    const r = await rig();
    const keepsakes = r.sup.services.require(KeepsakesKey);
    const who = { account: discord(ALICE), name: "Alice", avatar_url: null };
    const first = await keepsakes.issueCard(who, "k-1");
    expect(first.ok && first.value.number).toBe(1);
    const cookie = await r.login("alice");
    // The member page sees what the command issued, and the other way round.
    const page = (await r.get("/api/member/card", cookie)).body as { latest: Card; today: number };
    expect(page.today).toBe(1);
    expect(page.latest.serial).toBe(first.ok ? first.value.serial : "");
    expect(await keepsakes.cardsToday(who.account)).toMatchObject({
      today: 1,
      per_day: CARDS_PER_DAY,
    });
    for (let i = 1; i < CARDS_PER_DAY; i++) await keepsakes.issueCard(who, `k-${i + 1}`);
    expect(await keepsakes.issueCard(who, "k-last")).toEqual({
      ok: false,
      status: 429,
      message: "今天的卡已經發完了,明天再來",
    });
  });

  it("runs out after five a day", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const numbers: number[] = [];
    for (let i = 0; i < CARDS_PER_DAY; i++) {
      numbers.push(((await issue(r, cookie)).body as Card).number);
    }
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    const sixth = await issue(r, cookie);
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ error: "今天的卡已經發完了,明天再來" });
    expect((await r.get("/api/member/card", cookie)).body).toMatchObject({ today: 5 });
  });

  it("does not hand out more than five to clicks at the same time", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const all = await Promise.all(Array.from({ length: 8 }, () => issue(r, cookie)));
    expect(all.filter((res) => res.status === 200)).toHaveLength(CARDS_PER_DAY);
    const numbers = all.filter((res) => res.status === 200).map((res) => (res.body as Card).number);
    expect(numbers.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("takes an empty body only, so nobody can ask for someone else's", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const bob = r.people.get(BOB);
    for (const json of [{ person: bob }, { account: { platform: "discord", id: BOB } }]) {
      expect((await r.post("/api/member/card", cookie, json)).status).toBe(422);
    }
    expect((await r.post("/api/member/card", cookie, {}, false)).status).toBe(403);
    expect((await r.get("/api/member/card", cookie)).body).toMatchObject({ today: 0 });
  });

  it("can be checked by anyone with its serial, however it is typed", async () => {
    const r = await rig();
    const card = (await issue(r, await r.login("alice"))).body as Card;
    const res = await anyone(r, card.serial);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(card);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.text).not.toContain("SECRET");
    expect(res.text).not.toContain(ALICE);
    const flat = card.serial.replace(/-/g, "").toLowerCase();
    expect((await anyone(r, flat)).body).toEqual(card);
    const spaced = encodeURIComponent(` ${card.serial.toLowerCase()} `);
    expect((await anyone(r, spaced)).body).toEqual(card);
  });

  it("is unknown for a serial nobody was given, or one that is not a serial", async () => {
    const r = await rig();
    for (const serial of ["MYR-0000-0000-0000", "MYR-0000-0000-000U", "abc", "x".repeat(200)]) {
      const res = await anyone(r, serial);
      expect(res.status, serial).toBe(404);
      expect(res.body).toEqual({ error: "這張卡不存在或已經作廢" });
    }
  });

  it("reads I, L and O the way Crockford does", () => {
    expect(normalizeSerial("myr-ilo0-1234-abcd")).toBe("MYR-1100-1234-ABCD");
    expect(normalizeSerial("MYR1234ABCD5678")).toBe("MYR-1234-ABCD-5678");
    expect(normalizeSerial("MYR-1234-ABCD-567U")).toBeNull();
    expect(normalizeSerial("XYZ-1234-ABCD-5678")).toBeNull();
    expect(normalizeSerial("MYR-1234-ABCD-56789")).toBeNull();
  });

  it("limits checks per client, so serials are not for guessing", async () => {
    const r = await rig();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await anyone(r, "MYR-0000-0000-0000")).status);
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("is void once they ask her to forget them", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const card = (await issue(r, cookie)).body as Card;
    const res = await r.post("/api/member/forget", cookie, { confirm: true });
    expect(res.body).toEqual({ deleted: 3, about: 2, derived: 1, unverified: 1 });
    expect((await anyone(r, card.serial)).status).toBe(404);
    const after = (await r.get("/api/member/card", cookie)).body;
    expect(after).toMatchObject({ latest: null, today: 0 });
    // Numbering starts over.
    expect(((await issue(r, cookie)).body as Card).number).toBe(1);
  });

  it("gives a blocked person a stranger's card, stored and counted like anyone's", async () => {
    const r = await rig();
    const strip = ({ serial: _s, issued_at: _a, name: _n, ...rest }: Card) => rest;
    const stranger = (await issue(r, await r.login("dave"))).body as Card;
    expect(stranger).toMatchObject({
      call_name: null,
      relationship: null,
      affinity: null,
      trust: null,
      familiarity: null,
      public_feeling: null,
      number: 1,
    });
    expect(CARD_POSES.stranger).toContain(stranger.pose);
    for (const code of ["carol", "erin", "frank"]) {
      const cookie = await r.login(code);
      const res = await issue(r, cookie);
      expect(res.status, code).toBe(200);
      const card = res.body as Card;
      expect(strip(card), code).toEqual(strip(stranger));
      expect(res.text).not.toContain("SECRET");
      expect((await anyone(r, card.serial)).body, code).toEqual(card);
      expect((await r.get("/api/member/card", cookie)).body, code).toMatchObject({ today: 1 });
      // A forget that finds nothing still takes the card.
      await r.post("/api/member/forget", cookie, { confirm: true });
      expect((await anyone(r, card.serial)).status, code).toBe(404);
    }
  });

  it("are in the export", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const first = (await issue(r, cookie)).body as Card;
    const second = (await issue(r, cookie)).body as Card;
    const res = await r.get("/api/member/export", cookie);
    const body = res.body as { cards: Card[] };
    expect(body.cards).toEqual([second, first]);
    expect(shape(res.body).filter((k) => k.startsWith("cards"))).toEqual(
      CARD_SHAPE.map((k) => `cards[].${k}`),
    );
  });

  it("are not given by a Core without a card store", async () => {
    const r = await rig();
    r.sup.services.removeOwnedBy("cards");
    const cookie = await r.login("alice");
    expect((await r.get("/api/member/card", cookie)).body).toMatchObject({
      latest: null,
      today: 0,
      per_day: CARDS_PER_DAY,
      rerolls_left: 0,
    });
    const res = await issue(r, cookie);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "這個 Core 還不能發卡" });
    expect((await anyone(r, "MYR-0000-0000-0000")).status).toBe(404);
  });
});

describe("the wallet", () => {
  const WALLET_SHAPE = [
    "balance",
    "can_earn",
    "checked_in_today",
    "currency",
    "earn[].amount",
    "earn[].cap",
    "earn[].earned_today",
    "earn[].label",
    "earn[].reason",
    "frames.selected",
    "hungry",
    "on_board",
    "shop[].available",
    "shop[].id",
    "shop[].kind",
    "shop[].label",
    "shop[].price",
    "shop[].why",
    "streak",
    "today_earned",
  ];

  /** The rig with a real wallet on an in-memory ledger, and her hunger. */
  async function walletRig(config: Record<string, JsonValue> = {}) {
    const r = await rig();
    const coins = await SqliteStore.open(":memory:");
    cleanups.push(() => coins.close());
    const hunger = { value: 0.8 };
    const s = r.sup.services;
    s.provide("economy", CoinLedgerStoreKey, coins.coins);
    s.provide("economy", DealStoreKey, coins.deals);
    s.provide("self", SelfStateKey, {
      drives: () => ({ hunger: hunger.value }),
      adjust: (d: { hunger?: number }) => {
        hunger.value = Math.max(hunger.value + (d.hunger ?? 0), 0);
      },
    } as never);
    const economy = new EconomyService({
      // These tests pin the wallet's own sums: the one-time achievement and quest rewards of
      // economy 2.0 (a first check-in, a first meal) are tested in the economy package.
      config: EconomyConfigSchema.parse({
        achievement_cap: 0,
        quest_reward: 0,
        quest_bonus: 0,
        ...config,
      }),
      services: s,
      profile: "p",
      clock: { now: () => Date.now() },
      publish: () => undefined,
      log: getLogger("test"),
    });
    s.provide("economy", EconomyKey, economy);
    const spend = (path: string, cookie: string, json: unknown, key?: string) =>
      raw(r.base, "POST", path, {
        json,
        headers: {
          cookie: `miyoria_session=${cookie}`,
          "x-miyoria-request": "1",
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
      });
    const fund = (id: string, delta: number) =>
      coins.coins.post(
        {
          id: `seed-${id}-${delta}`,
          profile: "p",
          account: discord(id),
          delta,
          reason: "checkin",
          ref: null,
          idem_key: null,
          ts: "2026-01-01T00:00:00Z",
        },
        { wallet: [] },
      );
    return { ...r, coins, hunger, spend, fund };
  }

  it("shows their own wallet, field by field", async () => {
    const r = await walletRig();
    const cookie = await r.login("alice");
    const res = await r.get("/api/member/wallet", cookie);
    expect(res.status).toBe(200);
    expect(shape(res.body)).toEqual(WALLET_SHAPE);
    expect(res.body).toMatchObject({
      currency: "魚幣",
      balance: 0,
      can_earn: true,
      checked_in_today: false,
      hungry: "starving",
      frames: { owned: [], selected: null },
      recent: [],
      deals: [],
    });
  });

  it("shows her deals with them: what she said she would do, the reward, where it stands", async () => {
    const r = await walletRig();
    const cookie = await r.login("alice");
    await r.coins.deals.create({
      id: "deal-1",
      profile: "p",
      account: discord(ALICE),
      item: "rice",
      count: 2,
      value: 20,
      task: "喵喵叫",
      prepaid: false,
      escrow: null,
      status: "open",
      created_at: "2026-01-01T00:00:00Z",
      done_at: null,
      due_at: "2026-01-01T00:15:00Z",
      closed_at: null,
    });
    await r.coins.deals.create({
      id: "deal-2",
      profile: "p",
      account: discord(BOB),
      item: "dessert",
      count: 1,
      value: 25,
      task: "別人的約定",
      prepaid: false,
      escrow: null,
      status: "open",
      created_at: "2026-01-01T00:00:00Z",
      done_at: null,
      due_at: "2026-01-01T00:15:00Z",
      closed_at: null,
    });
    const res = await r.get("/api/member/wallet", cookie);
    expect(res.status).toBe(200);
    expect((res.body as { deals: unknown }).deals).toEqual([
      {
        task: "喵喵叫",
        reward_label: "2 碗白飯",
        status: "open",
        due_at: "2026-01-01T00:15:00.000Z",
      },
    ]);
    expect(shape(res.body)).toEqual(
      [
        ...WALLET_SHAPE,
        "deals[].due_at",
        "deals[].reward_label",
        "deals[].status",
        "deals[].task",
      ].sort(),
    );
  });

  it("shows her goals and bounties, takes pledges and keeps strangers out of them", async () => {
    const r = await walletRig();
    r.sup.services.provide("economy", GoalStoreKey, r.coins.goals);
    r.sup.services.provide("economy", BountyStoreKey, r.coins.bounties);
    const now = Date.now();
    await r.coins.goals.create({
      id: "goal-1",
      profile: "p",
      title: "新麥克風",
      promise: "學三種貓叫",
      target: 50,
      status: "open",
      created_at: new Date(now).toISOString() as never,
      deadline: new Date(now + 86_400_000).toISOString() as never,
      closed_at: null,
    });
    await r.coins.bounties.create({
      id: "bounty-1",
      profile: "p",
      task: "猜她的幸運數字",
      reward: 30,
      hold: "hold-1",
      status: "open",
      created_at: new Date(now).toISOString() as never,
      expires_at: new Date(now + 86_400_000).toISOString() as never,
      closed_at: null,
      winner: null,
    });
    await r.fund(ALICE, 100);
    const alice = await r.login("alice");
    const read = await r.get("/api/member/goals", alice);
    expect(read.status).toBe(200);
    expect(shape(read.body)).toEqual(
      [
        "goals[].deadline",
        "goals[].fulfilled",
        "goals[].id",
        "goals[].my_pledge",
        "goals[].promise",
        "goals[].raised",
        "goals[].status",
        "goals[].target",
        "goals[].title",
      ].sort(),
    );
    expect((read.body as { goals: unknown[] }).goals[0]).toMatchObject({
      id: "goal-1",
      raised: 0,
      my_pledge: 0,
      status: "open",
    });
    const bounties = await r.get("/api/member/bounties", alice);
    expect(shape(bounties.body)).toEqual(
      [
        "bounties[].expires_at",
        "bounties[].id",
        "bounties[].posted_at",
        "bounties[].reward",
        "bounties[].task",
      ].sort(),
    );
    expect((bounties.body as { bounties: unknown[] }).bounties[0]).toMatchObject({
      id: "bounty-1",
      reward: 30,
    });

    const pledge = await r.spend("/api/member/goals/goal-1/pledge", alice, { amount: 20 }, "p-1");
    expect(pledge.status).toBe(200);
    expect(pledge.body).toEqual({
      pledged: 20,
      raised: 20,
      target: 50,
      reached: false,
      balance: 80,
      duplicate: false,
    });
    const same = await r.spend("/api/member/goals/goal-1/pledge", alice, { amount: 20 }, "p-1");
    expect(same.body).toMatchObject({ pledged: 20, duplicate: true, balance: 80 });
    expect(await r.coins.coins.balance("p", [discord(ALICE)])).toBe(80);
    expect(
      ((await r.get("/api/member/goals", alice)).body as { goals: unknown[] }).goals[0],
    ).toMatchObject({
      raised: 20,
      my_pledge: 20,
    });
    for (const bad of [{ amount: 0 }, { amount: 1.5 }, { amount: 5, to: BOB }]) {
      expect((await r.spend("/api/member/goals/goal-1/pledge", alice, bad, "p-bad")).status).toBe(
        422,
      );
    }
    expect(
      (await r.spend("/api/member/goals/nope/pledge", alice, { amount: 5 }, "p-2")).status,
    ).toBe(400);

    // Strangers and blocked people read the goal like anyone, and cannot pledge.
    for (const who of ["dave", "carol", "erin", "frank"]) {
      const cookie = await r.login(who);
      const view = await r.get("/api/member/goals", cookie);
      expect(view.status, who).toBe(200);
      expect((view.body as { goals: unknown[] }).goals[0], who).toMatchObject({
        raised: 20,
        my_pledge: 0,
      });
      const res = await r.spend("/api/member/goals/goal-1/pledge", cookie, { amount: 5 }, "p-s");
      expect(res.status, who).toBe(403);
      expect(res.body).toEqual({ error: "她還不認識你,先和她說說話吧" });
    }
    // Reaching it ends it.
    const bob = await r.login("bob");
    expect(
      (await r.spend("/api/member/goals/goal-1/pledge", bob, { amount: 5 }, "p-0")).status,
    ).toBe(402);
    await r.fund(BOB, 100);
    const done = await r.spend("/api/member/goals/goal-1/pledge", bob, { amount: 100 }, "p-b");
    expect(done.body).toMatchObject({ pledged: 30, reached: true });
    expect(
      (await r.spend("/api/member/goals/goal-1/pledge", bob, { amount: 5 }, "p-c")).status,
    ).toBe(409);
    expect(await r.coins.goals.get("goal-1")).toMatchObject({ status: "reached" });

    // The owner sees it owed and marks it kept, once; a member cannot.
    const owed = await raw(r.base, "GET", "/api/economy/goals", { token: TOKEN });
    expect(owed.body).toMatchObject({
      goals: [{ id: "goal-1", promise: "學三種貓叫", fulfilled_at: null, fulfilled_by: null }],
    });
    const memberTry = await r.post("/api/economy/goals/goal-1/fulfill", alice, {});
    expect([401, 403]).toContain(memberTry.status);
    const mark = (id: string) =>
      raw(r.base, "POST", `/api/economy/goals/${id}/fulfill`, {
        token: TOKEN,
        json: {},
        headers: { "x-miyoria-request": "1" },
      });
    const kept = await mark("goal-1");
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ goal: { id: "goal-1", fulfilled_by: "owner" } });
    expect((await mark("goal-1")).status).toBe(409);
    expect((await mark("nope")).status).toBe(409);
    expect(
      ((await r.get("/api/member/goals", alice)).body as { goals: unknown[] }).goals[0],
    ).toMatchObject({ status: "reached", fulfilled: true });
  });

  it("checks in once a day", async () => {
    const r = await walletRig();
    const cookie = await r.login("alice");
    const first = await r.spend("/api/member/checkin", cookie, {});
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ gained: 10, streak: 1, balance: 10 });
    const again = await r.spend("/api/member/checkin", cookie, {});
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "今天已經簽到過了" });
    expect((await r.spend("/api/member/checkin", cookie, { who: BOB })).status).toBe(422);
    const view = (await r.get("/api/member/wallet", cookie)).body as Record<string, unknown>;
    expect(view).toMatchObject({ balance: 10, checked_in_today: true, streak: 1 });
    expect(shape(view)).toContain("recent[].label");
  });

  it("feeds her once per key, and says when coins are short or she is full", async () => {
    const r = await walletRig();
    await r.fund(ALICE, 25);
    const cookie = await r.login("alice");
    const first = await r.spend("/api/member/feed", cookie, { item: "rice" }, "click-1");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      accepted: true,
      eaten: 1,
      charged: 10,
      balance: 15,
      message: "她吃了一碗白飯",
    });
    const again = await r.spend("/api/member/feed", cookie, { item: "rice" }, "click-1");
    expect(again.body).toEqual(first.body);
    const short = await r.spend("/api/member/feed", cookie, { item: "big_bowl" }, "click-2");
    expect(short.status).toBe(402);
    expect(short.body).toEqual({ error: "魚幣不夠" });
    r.hunger.value = 0.05;
    const full = await r.spend("/api/member/feed", cookie, { item: "rice", count: 1 }, "c-3");
    expect(full.body).toMatchObject({ accepted: false, charged: 0, balance: 15 });
    for (const bad of [{ item: "steak" }, { item: "rice", count: 6 }, { item: "rice", to: BOB }]) {
      expect((await r.spend("/api/member/feed", cookie, bad, "c-4")).status).toBe(422);
    }
    expect((await r.spend("/api/member/feed", cookie, { item: "rice" }, "a b")).status).toBe(400);
    expect(await r.coins.coins.balance("p", [discord(ALICE)])).toBe(15);
  });

  it("answers a stranger and every blocked person alike, and charges nothing", async () => {
    const r = await walletRig();
    for (const id of [CAROL, ERIN, FRANK]) await r.fund(id, 500);
    const bodies = new Set<string>();
    for (const who of ["dave", "carol", "erin", "frank"]) {
      const cookie = await r.login(who);
      const view = await r.get("/api/member/wallet", cookie);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({ balance: 0, can_earn: false, hungry: null, recent: [] });
      bodies.add(view.text);
      for (const [path, json] of [
        ["/api/member/checkin", {}],
        ["/api/member/feed", { item: "rice" }],
        ["/api/member/letter", { text: "嗨" }],
        ["/api/member/screen", { text: "嗨" }],
        ["/api/member/expression", { expression: "heart" }],
        ["/api/member/frame", { buy: "sakura" }],
      ] as const) {
        const res = await r.spend(path, cookie, json, "k");
        expect(res.status, `${who} ${path}`).toBe(403);
        expect(res.body).toEqual({ error: "她還不認識你,先和她說說話吧" });
      }
    }
    expect(bodies.size).toBe(1);
    for (const id of [CAROL, ERIN, FRANK]) {
      expect(await r.coins.coins.balance("p", [discord(id)])).toBe(500);
    }
    expect(r.hunger.value).toBe(0.8);
  });

  it("sends letters through moderation and refuses expressions while the stage is down", async () => {
    const r = await walletRig();
    await r.fund(ALICE, 100);
    const cookie = await r.login("alice");
    const sent = await r.spend("/api/member/letter", cookie, { text: "今天辛苦了" }, "l-1");
    expect(sent.body).toEqual({
      accepted: true,
      charged: 15,
      balance: 85,
      message: "信送出去了,她有空會看",
    });
    const bad = await r.spend("/api/member/letter", cookie, { text: "BADWORD" }, "l-2");
    expect(bad.body).toMatchObject({ accepted: false, charged: 0, balance: 85 });
    expect((await r.spend("/api/member/letter", cookie, { text: " " }, "l-3")).status).toBe(400);
    const face = await r.spend("/api/member/expression", cookie, { expression: "blush" }, "e-1");
    expect(face.body).toEqual({
      accepted: false,
      charged: 0,
      balance: 85,
      message: "她現在沒有開台",
    });
  });

  it("puts a message on the screen only while she is live, and not for nothing", async () => {
    const r = await walletRig();
    await r.fund(ALICE, 100);
    const cookie = await r.login("alice");
    const down = await r.spend("/api/member/screen", cookie, { text: "加油" }, "s-1");
    expect(down.status).toBe(409);
    expect(down.body).toEqual({ error: "她現在沒有開台" });
    expect((await r.spend("/api/member/screen", cookie, { text: " " }, "s-2")).status).toBe(400);
    expect(
      (await r.spend("/api/member/screen", cookie, { text: "字".repeat(61) }, "s-3")).status,
    ).toBe(400);
    expect(await r.coins.coins.balance("p", [discord(ALICE)])).toBe(100);
  });

  it("buys a frame, puts it on the next card and keeps the wallet in the export", async () => {
    const r = await walletRig();
    await r.fund(ALICE, 120);
    const cookie = await r.login("alice");
    const bought = await r.spend("/api/member/frame", cookie, { buy: "sakura", select: "sakura" });
    expect(bought.body).toEqual({ owned: ["sakura"], selected: "sakura", balance: 20 });
    expect((await r.spend("/api/member/frame", cookie, { select: "gold" })).status).toBe(409);
    const card = (await r.post("/api/member/card", cookie, {})).body as { frame: string | null };
    expect(card.frame).toBe("sakura");
    const exported = (await r.get("/api/member/export", cookie)).body as {
      wallet: { balance: number; ledger: { delta: number; label: string }[] };
    };
    expect(exported.wallet.balance).toBe(20);
    expect(exported.wallet.ledger.map((l) => l.delta)).toEqual([-100, 120]);
    expect(exported.wallet.ledger[0]?.label).toBe("買卡框「櫻花」");
    // Forgetting leaves the wallet.
    await r.post("/api/member/forget", cookie, { confirm: true });
    expect(await r.coins.coins.balance("p", [discord(ALICE)])).toBe(20);
  });

  describe("card extras", () => {
    type Card = Record<string, unknown> & { serial: string; pose: string; number: number };
    type WRig = Awaited<ReturnType<typeof walletRig>>;
    const balance = (r: WRig) => r.coins.coins.balance("p", [discord(ALICE)]);
    const anyone = (r: WRig, serial: string) =>
      r.get(`/api/public/card/${serial}`, undefined, { "cf-connecting-ip": "203.0.113.21" });
    const failIssue = (r: WRig) => {
      const issue = r.store.cards.issue.bind(r.store.cards);
      r.store.cards.issue = async () => {
        throw new Error("disk full");
      };
      return () => {
        r.store.cards.issue = issue;
      };
    };

    it("lists prices, the band's poses and the rerolls left", async () => {
      const r = await walletRig();
      const cookie = await r.login("alice");
      const before = (await r.get("/api/member/card", cookie)).body as Record<string, unknown>;
      expect(before).toMatchObject({
        prices: { pose: 20, foil: 50, reroll: 30 },
        rerolls_left: 0,
        poses: [
          { id: "blush", label: "害羞臉紅" },
          { id: "squint", label: "瞇眼笑" },
          { id: "hand", label: "揮手" },
        ],
      });
      await r.spend("/api/member/card", cookie, {}, "c-1");
      expect((await r.get("/api/member/card", cookie)).body).toMatchObject({ rerolls_left: 2 });
    });

    it("charges a chosen pose and puts it on the card", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 100);
      const cookie = await r.login("alice");
      const res = await r.spend("/api/member/card", cookie, { pose: "hand" }, "p-1");
      expect(res.status).toBe(200);
      expect((res.body as Card).pose).toBe("hand");
      expect(await balance(r)).toBe(80);
      // The same key does not charge or issue twice.
      const again = await r.spend("/api/member/card", cookie, { pose: "hand" }, "p-1");
      expect((again.body as Card).serial).toBe((res.body as Card).serial);
      expect(await balance(r)).toBe(80);
    });

    it("refuses a pose outside their band, charging nothing", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 100);
      const cookie = await r.login("alice");
      const res = await r.spend("/api/member/card", cookie, { pose: "cold" }, "p-2");
      expect(res.status).toBe(400);
      expect(await balance(r)).toBe(100);
      expect((await r.get("/api/member/card", cookie)).body).toMatchObject({ today: 0 });
    });

    it("says no to a pose they cannot afford", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 10);
      const cookie = await r.login("alice");
      expect((await r.spend("/api/member/card", cookie, { pose: "hand" }, "p-3")).status).toBe(402);
      expect(await balance(r)).toBe(10);
    });

    it("charges foil, stores it and shows it when checked", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 100);
      const cookie = await r.login("alice");
      const plain = (await r.spend("/api/member/card", cookie, {}, "f-0")).body as Card;
      expect(plain.foil).toBe(false);
      const card = (await r.spend("/api/member/card", cookie, { foil: true }, "f-1")).body as Card;
      expect(card.foil).toBe(true);
      expect(await balance(r)).toBe(50);
      expect((await anyone(r, card.serial)).body).toMatchObject({ foil: true, voided_at: null });
    });

    it("takes both a pose and foil, with a charge each", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 100);
      const cookie = await r.login("alice");
      const res = await r.spend("/api/member/card", cookie, { pose: "squint", foil: true }, "b-1");
      expect(res.body).toMatchObject({ pose: "squint", foil: true });
      expect(await balance(r)).toBe(30);
    });

    it("gives the charges back when no card follows", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 100);
      const cookie = await r.login("alice");
      const restore = failIssue(r);
      const res = await r.spend("/api/member/card", cookie, { pose: "hand", foil: true }, "x-1");
      restore();
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await balance(r)).toBe(100);
    });

    it("does not charge for a card the day's limit refuses", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 100);
      const cookie = await r.login("alice");
      for (let i = 0; i < CARDS_PER_DAY; i++)
        await r.spend("/api/member/card", cookie, {}, `d-${i}`);
      const res = await r.spend("/api/member/card", cookie, { foil: true }, "d-x");
      expect(res.status).toBe(429);
      expect(await balance(r)).toBe(100);
    });

    it("a command orders foil and a reroll through the Keepsakes service, at the page's prices", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 100);
      const keepsakes = r.sup.services.require(KeepsakesKey);
      const who = { account: discord(ALICE), name: "Alice", avatar_url: null };
      expect(await keepsakes.rerollCard(who, "k-r0")).toMatchObject({ ok: false, status: 409 });
      const foil = await keepsakes.issueCard(who, "k-f", { foil: true });
      expect(foil).toMatchObject({ ok: true, value: { foil: true }, charged: 50, balance: 50 });
      expect(await keepsakes.cardsToday(who.account)).toMatchObject({
        today: 1,
        prices: { foil: 50, reroll: 30 },
        rerolls_left: 2,
      });
      const redone = await keepsakes.rerollCard(who, "k-r1");
      expect(redone).toMatchObject({ ok: true, charged: 30, balance: 20 });
      expect(redone.ok && foil.ok && redone.value.number).toBe(foil.ok ? foil.value.number : -1);
      // The page sees the reroll the command made.
      const cookie = await r.login("alice");
      const page = (await r.get("/api/member/card", cookie)).body as { latest: Card };
      expect(page.latest.serial).toBe(redone.ok ? redone.value.serial : "");
      // Not enough left for another foil card: refused in words, nothing charged.
      const poor = await keepsakes.issueCard(who, "k-f2", { foil: true });
      expect(poor).toMatchObject({ ok: false, status: 402 });
      expect(await balance(r)).toBe(20);
    });

    it("rerolls today's newest card: charged, the old one void, the new one outside the day's count", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 100);
      const cookie = await r.login("alice");
      const first = (await r.spend("/api/member/card", cookie, { foil: true }, "r-0")).body as Card;
      expect(await balance(r)).toBe(50);
      r.dice.value = 0.999;
      const res = await r.spend("/api/member/card/reroll", cookie, {}, "r-1");
      expect(res.status).toBe(200);
      const next = res.body as Card;
      expect(next.serial).not.toBe(first.serial);
      expect(next).toMatchObject({ number: first.number, foil: true, voided_at: null });
      expect(await balance(r)).toBe(20);
      const old = (await anyone(r, first.serial)).body as Card;
      expect(old.serial).toBe(first.serial);
      expect(typeof old.voided_at).toBe("string");
      const list = (await r.get("/api/member/card", cookie)).body as {
        latest: Card;
        today: number;
        rerolls_left: number;
      };
      expect(list.latest.serial).toBe(next.serial);
      expect(list.today).toBe(1);
      expect(list.rerolls_left).toBe(1);
      // The same key is the same reroll.
      const again = await r.spend("/api/member/card/reroll", cookie, {}, "r-1");
      expect((again.body as Card).serial).toBe(next.serial);
      expect(await balance(r)).toBe(20);
      const exported = (await r.get("/api/member/export", cookie)).body as { cards: Card[] };
      expect(exported.cards.map((c) => c.serial)).toContain(first.serial);
    });

    it("stops after the day's rerolls", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 500);
      const cookie = await r.login("alice");
      await r.spend("/api/member/card", cookie, {}, "n-0");
      expect((await r.spend("/api/member/card/reroll", cookie, {}, "n-1")).status).toBe(200);
      expect((await r.spend("/api/member/card/reroll", cookie, {}, "n-2")).status).toBe(200);
      const third = await r.spend("/api/member/card/reroll", cookie, {}, "n-3");
      expect(third.status).toBe(429);
      expect(await balance(r)).toBe(440);
    });

    it("has nothing to reroll without a card from today", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 100);
      const cookie = await r.login("alice");
      expect((await r.spend("/api/member/card/reroll", cookie, {}, "o-0")).status).toBe(409);
      const old = (await r.spend("/api/member/card", cookie, {}, "o-1")).body as Card;
      // Make that card two days old.
      const rec = await r.store.cards.bySerial("p", old.serial);
      if (!rec) throw new Error("no card");
      const aged = { ...rec, issued_at: new Date(Date.now() - 2 * 86_400_000).toISOString() };
      r.store.cards.listFor = async () => [aged as never];
      const res = await r.spend("/api/member/card/reroll", cookie, {}, "o-2");
      expect(res.status).toBe(409);
      expect(await balance(r)).toBe(100);
    });

    it("gives the money back and keeps the old card when the new one cannot be issued", async () => {
      const r = await walletRig();
      await r.fund(ALICE, 100);
      const cookie = await r.login("alice");
      const first = (await r.spend("/api/member/card", cookie, {}, "u-0")).body as Card;
      const restore = failIssue(r);
      const res = await r.spend("/api/member/card/reroll", cookie, {}, "u-1");
      restore();
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await balance(r)).toBe(100);
      expect((await anyone(r, first.serial)).body).toMatchObject({ voided_at: null });
      expect((await r.get("/api/member/card", cookie)).body).toMatchObject({
        latest: { serial: first.serial },
      });
    });

    it("rerolls only with a wallet and a session", async () => {
      const r = await rig();
      const cookie = await r.login("alice");
      await r.post("/api/member/card", cookie, {});
      expect((await r.post("/api/member/card/reroll", cookie, {})).status).toBe(503);
      expect((await r.post("/api/member/card/reroll", cookie, {}, false)).status).toBe(403);
    });
  });

  it("is not there on a Core without the economy module", async () => {
    const r = await rig();
    const cookie = await r.login("alice");
    const res = await r.get("/api/member/wallet", cookie);
    expect(res.status).toBe(503);
    const exported = (await r.get("/api/member/export", cookie)).body as { wallet: unknown };
    expect(exported.wallet).toEqual({ balance: 0, ledger: [] });
    const card = (await r.post("/api/member/card", cookie, {})).body as { frame: unknown };
    expect(card.frame).toBeNull();
  });
});

describe("between people, the sponsor board and fortune slips", () => {
  const SLIP = {
    rank: "大吉",
    title: "春風得意",
    poem: ["月落烏啼", "江楓漁火", "姑蘇城外", "夜半鐘聲"],
    fields: [{ label: "願望", text: "會實現" }],
    line: "今天也辛苦了",
  };

  /** The rig with a real wallet and fortune store, and a model she writes with. */
  async function socialRig(publicConfig: Record<string, JsonValue> = {}) {
    const r = await rig({ cache_secs: 1, ...publicConfig });
    const coins = await SqliteStore.open(":memory:");
    cleanups.push(() => coins.close());
    const s = r.sup.services;
    s.provide("economy", CoinLedgerStoreKey, coins.coins);
    s.provide("economy", DealStoreKey, coins.deals);
    s.provide("economy", FortuneStoreKey, coins.fortunes);
    s.provide("self", SelfStateKey, {
      drives: () => ({ hunger: 0.8 }),
      adjust: () => undefined,
    } as never);
    const model = {
      fail: false,
      slip: (): unknown => SLIP,
      asked: 0,
    };
    s.provide("llm", LlmRouterKey, {
      complete: async () => {
        model.asked += 1;
        if (model.fail) throw new Error("the model is down");
        return { text: JSON.stringify(model.slip()), finish_reason: "stop", usage: null };
      },
    } as never);
    const economy = new EconomyService({
      config: EconomyConfigSchema.parse({}),
      services: s,
      profile: "p",
      clock: { now: () => Date.now() },
      publish: () => undefined,
      log: getLogger("test"),
    });
    s.provide("economy", EconomyKey, economy);
    const spend = (path: string, cookie: string, json: unknown, key?: string) =>
      raw(r.base, "POST", path, {
        json,
        headers: {
          cookie: `miyoria_session=${cookie}`,
          "x-miyoria-request": "1",
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
      });
    const row = (id: string, delta: number, reason: string) =>
      coins.coins.post(
        {
          id: `seed-${id}-${reason}-${delta}`,
          profile: "p",
          account: discord(id),
          delta,
          reason,
          ref: null,
          idem_key: null,
          ts: new Date().toISOString(),
        },
        { wallet: [] },
      );
    const fund = (id: string, delta: number) => row(id, delta, "checkin");
    const balance = (id: string) => coins.coins.balance("p", [discord(id)]);
    return { ...r, coins, model, spend, row, fund, balance };
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const FORTUNE_SHAPE = [
    "balance",
    "charged",
    "fortune.date",
    "fortune.fields[].label",
    "fortune.fields[].text",
    "fortune.id",
    "fortune.issued_at",
    "fortune.line",
    "fortune.poem[]",
    "fortune.rank",
    "fortune.title",
  ];

  describe("transfers", () => {
    it("move coins between members once per key, in the receiver's ledger as well", async () => {
      const r = await socialRig();
      await r.fund(ALICE, 80);
      const cookie = await r.login("alice");
      const body = { to_discord_id: BOB, amount: 30 };
      const first = await r.spend("/api/member/transfer", cookie, body, "t-1");
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ sent: 30, balance: 50, to: "Bob" });
      expect((await r.spend("/api/member/transfer", cookie, body, "t-1")).body).toEqual(first.body);
      expect(await r.balance(ALICE)).toBe(50);
      expect(await r.balance(BOB)).toBe(30);
      const mine = (await r.get("/api/member/wallet", cookie)).body as {
        recent: { delta: number; label: string }[];
      };
      expect(mine.recent[0]).toMatchObject({ delta: -30, label: "轉給 Bob" });
      const theirs = (await r.get("/api/member/wallet", await r.login("bob"))).body as {
        recent: { delta: number; label: string }[];
      };
      expect(theirs.recent[0]).toMatchObject({ delta: 30, label: "Alice 轉給你" });
    });

    it("answer every receiver that cannot take them in the same words, and charge nothing", async () => {
      const r = await socialRig();
      await r.fund(ALICE, 80);
      const cookie = await r.login("alice");
      const bodies = new Set<string>();
      // blocked by the social tag, by role, on the card, never met, and nobody at all
      for (const id of [CAROL, ERIN, FRANK, DAVE, "99999999"]) {
        const res = await r.spend(
          "/api/member/transfer",
          cookie,
          { to_discord_id: id, amount: 5 },
          `x-${id}`,
        );
        expect(res.status, id).toBe(403);
        bodies.add(res.text);
      }
      expect([...bodies]).toEqual([JSON.stringify({ error: "對方現在收不到" })]);
      expect(await r.balance(ALICE)).toBe(80);
    });

    it("refuse yourself, a stranger sender, bad bodies and more than the limit", async () => {
      const r = await socialRig();
      await r.fund(ALICE, 80);
      await r.fund(DAVE, 80);
      const cookie = await r.login("alice");
      const to = (amount: number) => ({ to_discord_id: BOB, amount });
      expect(
        (await r.spend("/api/member/transfer", cookie, { to_discord_id: ALICE, amount: 5 }, "a"))
          .status,
      ).toBe(400);
      expect((await r.spend("/api/member/transfer", cookie, to(51), "b")).status).toBe(400);
      expect((await r.spend("/api/member/transfer", cookie, to(81), "c")).status).toBe(400);
      for (const bad of [
        to(0),
        { to_discord_id: "abc", amount: 5 },
        { ...to(5), extra: 1 },
        { amount: 5 },
        { to_discord_id: BOB, amount: "5" },
      ]) {
        expect((await r.spend("/api/member/transfer", cookie, bad, "d")).status).toBe(422);
      }
      const stranger = await r.spend("/api/member/transfer", await r.login("dave"), to(5), "e");
      expect(stranger.status).toBe(403);
      expect(stranger.body).toEqual({ error: "她還不認識你,先和她說說話吧" });
      expect(await r.balance(ALICE)).toBe(80);
      expect(await r.balance(BOB)).toBe(0);
    });
  });

  describe("the sponsor board", () => {
    it("lists everyone who spent, by name and number, to anyone, and drops those who leave", async () => {
      const r = await socialRig();
      await r.row(ALICE, -40, "feed");
      await r.row(BOB, -90, "feed");
      const cookie = await r.login("alice");
      expect(
        ((await r.get("/api/member/wallet", cookie)).body as { on_board: boolean }).on_board,
      ).toBe(true);
      expect((await r.spend("/api/member/board", cookie, { on: "yes" })).status).toBe(422);
      expect((await r.spend("/api/member/board", cookie, { on: true, who: BOB })).status).toBe(422);
      const stranger = await r.spend("/api/member/board", await r.login("dave"), { on: true });
      expect(stranger.status).toBe(403);

      const board = await r.get("/api/public/board");
      expect(board.status).toBe(200);
      expect(board.body).toEqual({
        entries: [
          { rank: 1, name: "Bob", spent: 90 },
          { rank: 2, name: "Alice", spent: 40 },
        ],
      });
      expect(shape(board.body)).toEqual(["entries[].name", "entries[].rank", "entries[].spent"]);
      // No account id, no platform, no balance.
      for (const secret of [ALICE, BOB, OWNER, "discord"]) expect(board.text).not.toContain(secret);

      expect((await r.spend("/api/member/board", cookie, { on: false })).body).toEqual({
        on_board: false,
      });
      await wait(1100);
      expect((await r.get("/api/public/board")).body).toEqual({
        entries: [{ rank: 1, name: "Bob", spent: 90 }],
      });
      expect((await r.spend("/api/member/board", cookie, { on: true })).body).toEqual({
        on_board: true,
      });
    });
  });

  describe("fortune slips", () => {
    it("are written once a day for the price, kept, and asked again for nothing", async () => {
      const r = await socialRig();
      await r.fund(ALICE, 30);
      const cookie = await r.login("alice");
      expect((await r.get("/api/member/fortune", cookie)).body).toEqual({
        fortune: null,
        price: 10,
      });

      const first = await r.spend("/api/member/fortune", cookie, {}, "f-1");
      expect(first.status).toBe(200);
      expect(shape(first.body)).toEqual(FORTUNE_SHAPE);
      const slip = (first.body as { fortune: Record<string, unknown> }).fortune;
      expect(slip).toMatchObject(SLIP);
      expect(first.body).toMatchObject({ charged: 10, balance: 20 });
      expect(await r.balance(ALICE)).toBe(20);
      expect((await r.get("/api/member/fortune", cookie)).body).toEqual({
        fortune: slip,
        price: 10,
      });

      // The same key, and another key the same day: the same slip, nothing more charged, no more asking.
      const asked = r.model.asked;
      for (const key of ["f-1", "f-2"]) {
        const again = await r.spend("/api/member/fortune", cookie, {}, key);
        expect(again.status).toBe(200);
        expect(again.body).toEqual({ fortune: slip, charged: 0, balance: 20 });
      }
      expect(r.model.asked).toBe(asked);
      expect(await r.balance(ALICE)).toBe(20);
    });

    it("can be drawn from a command through the Keepsakes service, and the page shows the same slip", async () => {
      const r = await socialRig();
      await r.fund(ALICE, 30);
      const keepsakes = r.sup.services.require(KeepsakesKey);
      const who = { account: discord(ALICE), name: "Alice", avatar_url: null };
      expect(await keepsakes.fortuneToday(who.account)).toEqual({ fortune: null, price: 10 });
      const drawn = await keepsakes.drawFortune(who, "c-1");
      expect(drawn).toMatchObject({ ok: true, charged: 10, balance: 20 });
      const cookie = await r.login("alice");
      expect((await r.get("/api/member/fortune", cookie)).body).toEqual({
        fortune: drawn.ok ? drawn.value : null,
        price: 10,
      });
      const again = await keepsakes.drawFortune(who, "c-2");
      expect(again).toMatchObject({ ok: true, charged: 0, balance: 20 });
      // Someone she does not know gets the same words as on the page.
      const stranger = { account: discord("999"), name: "路人", avatar_url: null };
      expect(await keepsakes.drawFortune(stranger, "c-3")).toMatchObject({
        ok: false,
        status: 403,
      });
    });

    it("give the payment back when she cannot write, and a retry of that key buys nothing", async () => {
      const r = await socialRig();
      await r.fund(ALICE, 30);
      const cookie = await r.login("alice");
      r.model.fail = true;
      const failed = await r.spend("/api/member/fortune", cookie, {}, "g-1");
      expect(failed.status).toBe(503);
      expect(failed.body).toEqual({ error: "她現在寫不出來,魚幣已經退回" });
      expect(await r.balance(ALICE)).toBe(30);
      expect((await r.get("/api/member/fortune", cookie)).body).toEqual({
        fortune: null,
        price: 10,
      });

      r.model.fail = false;
      const retry = await r.spend("/api/member/fortune", cookie, {}, "g-1");
      expect(retry.status).toBe(409);
      expect(await r.balance(ALICE)).toBe(30);
      const fresh = await r.spend("/api/member/fortune", cookie, {}, "g-2");
      expect(fresh.status).toBe(200);
      expect(await r.balance(ALICE)).toBe(20);
    });

    it("are not kept when a poem line names someone else, and the payment goes back", async () => {
      const r = await socialRig();
      await r.fund(ALICE, 30);
      const cookie = await r.login("alice");
      r.model.slip = () => ({ ...SLIP, poem: ["Bob來了", "江楓漁火", "姑蘇城外", "夜半鐘聲"] });
      const res = await r.spend("/api/member/fortune", cookie, {}, "n-1");
      expect(res.status).toBe(503);
      expect(await r.balance(ALICE)).toBe(30);
      // A field naming him is only left off.
      r.model.slip = () => ({ ...SLIP, fields: [{ label: "戀愛", text: "和 Bob 有緣" }] });
      const ok = await r.spend("/api/member/fortune", cookie, {}, "n-2");
      expect(ok.status).toBe(200);
      expect((ok.body as { fortune: { fields: unknown[] } }).fortune.fields).toEqual([]);
    });

    it("are refused to strangers and the blocked in the words of the wallet, and without a model", async () => {
      const r = await socialRig();
      for (const id of [CAROL, DAVE, ERIN, FRANK]) await r.fund(id, 50);
      for (const who of ["carol", "dave", "erin", "frank"]) {
        const res = await r.spend("/api/member/fortune", await r.login(who), {}, "k");
        expect(res.status, who).toBe(403);
        expect(res.body).toEqual({ error: "她還不認識你,先和她說說話吧" });
        const view = await r.get("/api/member/fortune", await r.login(who));
        expect(view.body).toEqual({ fortune: null, price: 10 });
      }
      for (const id of [CAROL, DAVE, ERIN, FRANK]) expect(await r.balance(id)).toBe(50);
      expect(r.model.asked).toBe(0);

      await r.fund(ALICE, 30);
      r.sup.services.removeOwnedBy("llm");
      const cookie = await r.login("alice");
      expect((await r.spend("/api/member/fortune", cookie, {}, "m")).status).toBe(503);
      expect(await r.balance(ALICE)).toBe(30);
      expect((await r.spend("/api/member/fortune", cookie, { to: BOB }, "m")).status).toBe(422);
    });

    it("are in the export, and go when they ask to be forgotten", async () => {
      const r = await socialRig();
      await r.fund(ALICE, 30);
      const cookie = await r.login("alice");
      const made = (await r.spend("/api/member/fortune", cookie, {}, "x-1")).body as {
        fortune: unknown;
      };
      const exported = (await r.get("/api/member/export", cookie)).body as { fortunes: unknown[] };
      expect(exported.fortunes).toEqual([made.fortune]);
      expect(shape(exported.fortunes)).toEqual(
        [
          "[].date",
          "[].fields[].label",
          "[].fields[].text",
          "[].id",
          "[].issued_at",
          "[].line",
          "[].poem[]",
          "[].rank",
          "[].title",
        ].sort(),
      );
      await r.post("/api/member/forget", cookie, { confirm: true });
      const after = (await r.get("/api/member/export", cookie)).body as { fortunes: unknown[] };
      expect(after.fortunes).toEqual([]);
      expect((await r.get("/api/member/fortune", cookie)).body).toEqual({
        fortune: null,
        price: 10,
      });
    });
  });
});

describe("link previews", () => {
  const PAGE = `<!doctype html><html><head><meta charset="UTF-8" />
    <!-- meta:start -->
    <title>Miyoria</title>
    <meta property="og:title" content="static" />
    <!-- meta:end -->
  </head><body><div id="root"></div></body></html>`;
  const BLANK: IssuedCard = {
    serial: "MYR-0000-0000-0000",
    issued_at: "2026-01-01T00:00:00.000Z",
    name: "A",
    avatar_url: null,
    number: 1,
    call_name: null,
    relationship: "朋友",
    affinity: null,
    trust: null,
    familiarity: null,
    public_feeling: null,
    line: null,
    stamp: null,
    fields: [],
    pose: "calm",
    frame: null,
    foil: false,
    voided_at: null,
  };
  const BOT = { "user-agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" };
  const SHOWN = {
    "x-forwarded-host": "miyoria.example.test",
    "x-forwarded-proto": "https",
    "cf-connecting-ip": "203.0.113.30",
  };

  async function preview() {
    const dir = await mkdtemp(join(tmpdir(), "myr-panel-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "index.html"), PAGE);
    const r = await rig({}, dir);
    return r;
  }
  const meta = (html: string, name: string): string | null =>
    new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)"`).exec(html)?.[1] ?? null;
  const png = async (url: string, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { headers: { ...BOT, ...SHOWN, ...headers } });
    return { res, bytes: Buffer.from(await res.arrayBuffer()) };
  };

  it("gives every page its title, description and the site's picture", async () => {
    const r = await preview();
    const { text, headers } = await r.get("/", undefined, { ...BOT, ...SHOWN });
    expect(headers.get("content-type")).toContain("text/html");
    expect(text).toContain("<title>Miyoria</title>");
    expect(text).not.toContain("static");
    expect(meta(text, "og:title")).toBe("Miyoria");
    expect(meta(text, "og:site_name")).toBe("Miyoria");
    expect(meta(text, "og:url")).toBe("https://miyoria.example.test/");
    expect(meta(text, "og:image")).toBe("https://miyoria.example.test/og/default.png");
    expect(meta(text, "og:description")).toContain("AI VTuber");
    expect(meta(text, "twitter:card")).toBe("summary_large_image");
    const me = (await r.get("/me", undefined, { ...BOT, ...SHOWN })).text;
    expect(meta(me, "og:title")).toBe("我的頁面 · Miyoria");
    expect(me).toContain('content="noindex, nofollow"');
    // The public live page is `/watch`, open to search; `/live` is the admin panel's.
    const watch = (await r.get("/watch", undefined, { ...BOT, ...SHOWN })).text;
    expect(meta(watch, "og:title")).toBe("現場 · Miyoria");
    expect(watch).not.toContain('content="noindex, nofollow"');
    const live = (await r.get("/live", undefined, { ...BOT, ...SHOWN })).text;
    expect(meta(live, "og:title")).toBe("管理面板 · Miyoria");
  });

  it("serves the site's picture as a PNG", async () => {
    const r = await preview();
    const { res, bytes } = await png(`${r.base}/og/default.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(bytes.readUInt32BE(20)).toBe(630);
  });

  it("puts the card on its own page's tags, with a picture of the card", async () => {
    const r = await preview();
    const cookie = await r.login("alice");
    const card = (await r.post("/api/member/card", cookie, {})).body as {
      serial: string;
      name: string;
      relationship: string;
      public_feeling: string;
    };
    const { text } = await r.get(`/card/${card.serial}`, undefined, { ...BOT, ...SHOWN });
    expect(meta(text, "og:title")).toBe(`${card.name} 的會員卡 · Miyoria`);
    expect(meta(text, "og:description")).toContain(card.serial);
    expect(meta(text, "og:description")).toContain(card.relationship);
    expect(meta(text, "og:url")).toBe(`https://miyoria.example.test/card/${card.serial}`);
    expect(meta(text, "twitter:card")).toBe("summary_large_image");
    const image = meta(text, "og:image") ?? "";
    expect(image).toMatch(
      /^https:[/][/]miyoria[.]example[.]test[/]og[/]card[/]MYR-[0-9A-Z-]+[.]png[?]v=[0-9a-f]{10}$/,
    );
    expect(image).toContain(card.serial);
    expect(meta(text, "twitter:image")).toBe(image);
    expect(text).not.toContain("SECRET");
    const path = new URL(image).pathname + new URL(image).search;
    const { res, bytes } = await png(`${r.base}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(bytes.readUInt32BE(16)).toBe(1000);
    expect(bytes.readUInt32BE(20)).toBe(1397);
    // An old version of the link still gets the card, but may not be kept for long.
    const stale = await png(`${r.base}/og/card/${card.serial}.png?v=0000000000`);
    expect(stale.res.status).toBe(200);
    expect(stale.res.headers.get("cache-control")).not.toContain("immutable");
    expect(stale.bytes.equals(bytes)).toBe(true);
  });

  it("changes the picture's address when the card's data changes", () => {
    const base = BLANK;
    expect(cardVersion(base)).toBe(cardVersion({ ...base }));
    expect(cardVersion(base)).not.toBe(cardVersion({ ...base, frame: "gold" }));
    expect(cardVersion(base)).not.toBe(
      cardVersion({ ...base, voided_at: "2026-01-02T00:00:00.000Z" }),
    );
  });

  it("shows nothing of anybody for an unknown or malformed serial", async () => {
    const r = await preview();
    for (const serial of ["MYR-0000-0000-0000", "not-a-card", "MYR-1234"]) {
      const { text } = await r.get(`/card/${serial}`, undefined, { ...BOT, ...SHOWN });
      expect(meta(text, "og:title")).toBe("會員卡 · Miyoria");
      expect(meta(text, "og:image")).toBe("https://miyoria.example.test/og/default.png");
      expect(text).not.toContain("MYR-0000");
      const picture = await png(`${r.base}/og/card/${serial}.png`);
      expect(picture.res.status).toBe(200);
      expect(picture.bytes.readUInt32BE(16)).toBe(1200);
    }
  });

  it("escapes what a card's name says in the tags", () => {
    const tags = injectMeta(
      PAGE,
      cardMeta(
        { ...BLANK, name: '"><script>x</script>' },
        "https://a.test",
        "https://a.test/i.png",
      ),
    );
    expect(tags).not.toContain("<script>");
    expect(tags).toContain("&lt;script&gt;");
  });
});
