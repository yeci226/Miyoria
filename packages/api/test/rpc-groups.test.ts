// The public, member, wallet, agency and fortune groups of the route table: each route says what the old route said (who may
// call it, and which method and path), and its answer loses every field the schema does not name.
// The routes' behaviour (limits, refusals, words) is held by `public.test.ts`.

import {
  type ApiOutputs,
  contract,
  FeedItemSchema,
  FeedRequestSchema,
  GiftExpressionSchema,
  routeMeta,
} from "@miyoria/contracts/api";
import { FEED_ITEMS, GIFT_EXPRESSIONS, MAX_FEED_COUNT } from "@miyoria/economy";
import { implement } from "@orpc/server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RpcContext } from "../src/contract.js";
import { ApiError } from "../src/errors.js";
import { rpcRoutes, tableRoutes } from "../src/rpc.js";
import type { ApiEnv } from "../src/state.js";

type Audience = "public" | "member";

interface Case {
  /** The route's name in the table: `member.me`. */
  name: string;
  method: "GET" | "POST";
  path: string;
  audience: Audience;
  /** The request to send: a body for a change. */
  request?: { json: unknown };
}

/** A change by a member. */
function post(name: string, path: string, json: unknown): Case {
  return { name, method: "POST", path, audience: "member", request: { json } };
}

/** The routes as the old table had them: the `public` or `member` flag, method and path. */
const CASES: Case[] = [
  { name: "public.status", method: "GET", path: "/api/public/status", audience: "public" },
  { name: "public.songs", method: "GET", path: "/api/public/songs", audience: "public" },
  { name: "public.board", method: "GET", path: "/api/public/board", audience: "public" },
  { name: "public.card", method: "GET", path: "/api/public/card/MYR-0", audience: "public" },
  { name: "member.session", method: "GET", path: "/api/member/session", audience: "member" },
  { name: "member.me", method: "GET", path: "/api/member/me", audience: "member" },
  {
    name: "member.forget",
    method: "POST",
    path: "/api/member/forget",
    audience: "member",
    request: { json: { confirm: true } },
  },
  {
    name: "member.requestSong",
    method: "POST",
    path: "/api/member/songs",
    audience: "member",
    request: { json: { query: "a song" } },
  },
  { name: "member.cards", method: "GET", path: "/api/member/card", audience: "member" },
  {
    name: "member.issueCard",
    method: "POST",
    path: "/api/member/card",
    audience: "member",
    request: { json: {} },
  },
  { name: "wallet.view", method: "GET", path: "/api/member/wallet", audience: "member" },
  post("wallet.checkin", "/api/member/checkin", {}),
  post("wallet.feed", "/api/member/feed", { item: "rice" }),
  post("wallet.letter", "/api/member/letter", { text: "hi" }),
  post("wallet.screen", "/api/member/screen", { text: "hi" }),
  post("wallet.expression", "/api/member/expression", { expression: "heart" }),
  post("wallet.transfer", "/api/member/transfer", { to_discord_id: "1", amount: 1 }),
  post("wallet.board", "/api/member/board", { on: true }),
  post("wallet.frame", "/api/member/frame", { buy: "sakura" }),
  post("member.pat", "/api/member/live/pat", {}),
  { name: "agency.goals", method: "GET", path: "/api/member/goals", audience: "member" },
  post("agency.pledge", "/api/member/goals/g1/pledge", { amount: 1 }),
  { name: "agency.bounties", method: "GET", path: "/api/member/bounties", audience: "member" },
  { name: "fortune.today", method: "GET", path: "/api/member/fortune", audience: "member" },
  post("fortune.draw", "/api/member/fortune", {}),
  {
    name: "member.rerollCard",
    method: "POST",
    path: "/api/member/card/reroll",
    audience: "member",
    request: { json: {} },
  },
];

/** The member routes that never counted against the member's rate limit. */
const UNLIMITED = new Set(["member.forget", "member.requestSong", "member.pat"]);

const CARD = {
  serial: "MYR-AAAA-BBBB-CCCC",
  issued_at: "2026-11-08T03:00:00.000Z",
  name: "Alice",
  avatar_url: null,
  number: 1,
  call_name: null,
  relationship: null,
  affinity: null,
  trust: null,
  familiarity: null,
  public_feeling: null,
  line: null,
  stamp: null,
  fields: [{ label: "a", text: "b" }],
  pose: "calm",
  frame: null,
  foil: false,
  voided_at: null,
} satisfies ApiOutputs["member"]["issueCard"];

const WORDS = {
  call_name: null,
  relationship: null,
  affinity: null,
  trust: null,
  familiarity: null,
  public_feeling: null,
};

const SPENT = {
  accepted: true,
  charged: 1,
  balance: 1,
  message: "a",
} satisfies ApiOutputs["wallet"]["letter"];

const SLIP = {
  id: "f1",
  date: "2026-11-08",
  issued_at: "2026-11-08T03:00:00Z",
  rank: "吉",
  title: "a",
  poem: ["a", "b", "c", "d"],
  fields: [{ label: "a", text: "b" }],
  line: null,
} satisfies ApiOutputs["fortune"]["today"]["fortune"];

/** What each route answers: the whole of its schema, and a field it does not name on top. */
const ANSWERS = {
  "public.status": {
    state: "idle",
    live: false,
    in_voice: false,
    game: null,
    today: { songs_sung: 0, hours_live: 0, hours_in_voice: 0 },
    days: [{ date: "2026-11-08", songs_sung: 0, hours_live: 0, hours_in_voice: 0 }],
  } satisfies ApiOutputs["public"]["status"],
  "public.songs": {
    playing: null,
    upcoming: [],
    recent: [],
  } satisfies ApiOutputs["public"]["songs"],
  "public.board": {
    entries: [{ rank: 1, name: "a", spent: 3 }],
  } satisfies ApiOutputs["public"]["board"],
  "public.card": CARD,
  "member.session": { name: "Alice", avatar_url: null } satisfies ApiOutputs["member"]["session"],
  "member.me": {
    card: WORDS,
    bond: null,
    memories: [{ text: "a", kind: "fact", date: "2026-11-08" }],
    songs: [],
    activity: [{ date: "2026-11-08", text: 1, voice: 0 }],
    can_request_song: false,
    forget: { removes: "a", keeps: "b" },
  } satisfies ApiOutputs["member"]["me"],
  "member.forget": {
    deleted: 0,
    about: 0,
    derived: 0,
    unverified: 0,
  } satisfies ApiOutputs["member"]["forget"],
  "member.requestSong": { accepted: true } satisfies ApiOutputs["member"]["requestSong"],
  "member.cards": {
    latest: CARD,
    today: 1,
    per_day: 5,
    poses: [{ id: "calm", label: "a" }],
    prices: { pose: null, foil: null, reroll: null },
    rerolls_left: 0,
  } satisfies ApiOutputs["member"]["cards"],
  "wallet.view": {
    currency: "魚幣",
    balance: 1,
    can_earn: true,
    today_earned: 0,
    checked_in_today: false,
    streak: 0,
    earn: [{ reason: "checkin", label: "a", amount: 1, earned_today: 0, cap: 1 }],
    shop: [{ id: "rice", kind: "feed", label: "a", price: 1, available: true, why: null }],
    frames: { owned: [], selected: null },
    hungry: "ok",
    recent: [{ ts: "2026-11-08T03:00:00Z", delta: 1, label: "a" }],
    deals: [{ task: "a", reward_label: "b", status: "open", due_at: null }],
    on_board: false,
  } satisfies ApiOutputs["wallet"]["view"],
  "wallet.checkin": { gained: 1, streak: 1, balance: 1 } satisfies ApiOutputs["wallet"]["checkin"],
  "wallet.feed": {
    accepted: true,
    eaten: 1,
    charged: 1,
    balance: 1,
    message: "a",
  } satisfies ApiOutputs["wallet"]["feed"],
  "wallet.letter": SPENT,
  "wallet.screen": SPENT,
  "wallet.expression": SPENT,
  "wallet.transfer": { sent: 1, balance: 1, to: "a" } satisfies ApiOutputs["wallet"]["transfer"],
  "wallet.board": { on_board: true } satisfies ApiOutputs["wallet"]["board"],
  "wallet.frame": {
    owned: ["sakura"],
    selected: null,
    balance: 1,
  } satisfies ApiOutputs["wallet"]["frame"],
  "agency.goals": {
    goals: [
      {
        id: "g1",
        title: "a",
        promise: "b",
        target: 2,
        raised: 1,
        my_pledge: 0,
        deadline: "2099-01-01T00:00:00Z",
        status: "open",
        fulfilled: false,
      },
    ],
  } satisfies ApiOutputs["agency"]["goals"],
  "agency.pledge": {
    pledged: 1,
    raised: 1,
    target: 2,
    reached: false,
    balance: 1,
    duplicate: false,
  } satisfies ApiOutputs["agency"]["pledge"],
  "agency.bounties": {
    bounties: [{ id: "b1", task: "a", reward: 1, posted_at: "x", expires_at: "y" }],
  } satisfies ApiOutputs["agency"]["bounties"],
  "fortune.today": { fortune: SLIP, price: 10 } satisfies ApiOutputs["fortune"]["today"],
  "fortune.draw": {
    fortune: SLIP,
    charged: 10,
    balance: 1,
  } satisfies ApiOutputs["fortune"]["draw"],
  "member.pat": { pats: { recent: 1, open: true } } satisfies ApiOutputs["member"]["pat"],
  "member.issueCard": CARD,
  "member.rerollCard": CARD,
} as const;

/** `value` with an extra field at the top and in every object and array of objects below. */
function leaky(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(leaky);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = { leak: "x" };
  for (const [key, inner] of Object.entries(value)) out[key] = leaky(inner);
  return out;
}

describe("the public and member routes of the table", () => {
  it.each(CASES)("$name is $method $path, for the $audience", (c) => {
    const [group, route] = c.name.split(".") as [string, string];
    expect(routeMeta(contract, [group, route])).toEqual({
      audience: c.audience,
      permission: null,
      ...(UNLIMITED.has(c.name) || c.audience === "public" ? {} : { limited: true }),
    });
  });

  it("holds the shell's flags the old routes had", () => {
    const state = { publicSide: { config: { enabled: true } }, optional: () => undefined };
    const routes = rpcRoutes(state as never);
    for (const c of CASES) {
      const found = routes.filter((r) => r.method === c.method && r.path === pathOf(c));
      expect(found, c.name).toHaveLength(1);
      expect(Boolean(found[0]?.public), `${c.name} public`).toBe(c.audience === "public");
      expect(Boolean(found[0]?.member), `${c.name} member`).toBe(c.audience === "member");
    }
  });

  it("goes away with the public side's switch", () => {
    const state = { publicSide: { config: { enabled: false } }, optional: () => undefined };
    const paths = rpcRoutes(state as never).map((r) => r.path);
    for (const c of CASES) expect(paths).not.toContain(pathOf(c));
    expect(paths).toContain("/api/health");
  });
});

/** The route's Hono path: `/api/public/card/MYR-0` is the `:serial` route. */
function pathOf(c: Case): string {
  if (c.name === "public.card") return "/api/public/card/:serial";
  if (c.name === "agency.pledge") return "/api/member/goals/:id/pledge";
  return c.path;
}

describe("the answers", () => {
  // The real handlers need a running module; here each route's handler answers with more than its
  // schema says, and what leaves is the schema's.
  const os = implement({
    public: contract.public,
    member: contract.member,
    wallet: contract.wallet,
    agency: contract.agency,
    fortune: contract.fortune,
  }).$context<RpcContext>();
  const answer = (name: keyof typeof ANSWERS) => () => leaky(ANSWERS[name]) as never;
  const table = os.router({
    public: {
      status: os.public.status.handler(answer("public.status")),
      songs: os.public.songs.handler(answer("public.songs")),
      board: os.public.board.handler(answer("public.board")),
      card: os.public.card.handler(answer("public.card")),
    },
    member: {
      session: os.member.session.handler(answer("member.session")),
      me: os.member.me.handler(answer("member.me")),
      forget: os.member.forget.handler(answer("member.forget")),
      requestSong: os.member.requestSong.handler(answer("member.requestSong")),
      cards: os.member.cards.handler(answer("member.cards")),
      issueCard: os.member.issueCard.handler(answer("member.issueCard")),
      rerollCard: os.member.rerollCard.handler(answer("member.rerollCard")),
      pat: os.member.pat.handler(answer("member.pat")),
    },
    wallet: {
      view: os.wallet.view.handler(answer("wallet.view")),
      checkin: os.wallet.checkin.handler(answer("wallet.checkin")),
      feed: os.wallet.feed.handler(answer("wallet.feed")),
      letter: os.wallet.letter.handler(answer("wallet.letter")),
      screen: os.wallet.screen.handler(answer("wallet.screen")),
      expression: os.wallet.expression.handler(answer("wallet.expression")),
      transfer: os.wallet.transfer.handler(answer("wallet.transfer")),
      board: os.wallet.board.handler(answer("wallet.board")),
      frame: os.wallet.frame.handler(answer("wallet.frame")),
    },
    agency: {
      goals: os.agency.goals.handler(answer("agency.goals")),
      pledge: os.agency.pledge.handler(answer("agency.pledge")),
      bounties: os.agency.bounties.handler(answer("agency.bounties")),
    },
    fortune: {
      today: os.fortune.today.handler(answer("fortune.today")),
      draw: os.fortune.draw.handler(answer("fortune.draw")),
    },
  });
  const state = {
    publicSide: { config: { enabled: true }, admitMember: () => null },
    optional: () => undefined,
  };
  const hono = new Hono<ApiEnv>();
  for (const r of tableRoutes(state as never, table, { responseCheck: "production" })) {
    hono.on(r.method, r.path, async (c) => {
      c.set("member", { account: { platform: "discord", id: "1" } } as never);
      try {
        return await r.handler(c);
      } catch (error) {
        return error instanceof ApiError
          ? error.toResponse()
          : ApiError.internal(error).toResponse();
      }
    });
  }

  it.each(CASES)("$name sends only what its schema names", async (c) => {
    const init: RequestInit = { method: c.method };
    if (c.request) {
      init.body = JSON.stringify(c.request.json);
      init.headers = { "content-type": "application/json" };
    }
    const response = await hono.request(c.path, init);
    expect(response.status, c.name).toBe(200);
    expect(await response.json()).toEqual(ANSWERS[c.name as keyof typeof ANSWERS]);
  });
});

describe("what the contract says again of the economy", () => {
  it("allows the items, expressions and count the wallet has", () => {
    expect(FeedItemSchema.options).toEqual([...FEED_ITEMS]);
    expect(GiftExpressionSchema.options).toEqual([...GIFT_EXPRESSIONS]);
    expect(FeedRequestSchema.safeParse({ item: "rice", count: MAX_FEED_COUNT }).success).toBe(true);
    expect(FeedRequestSchema.safeParse({ item: "rice", count: MAX_FEED_COUNT + 1 }).success).toBe(
      false,
    );
  });
});
