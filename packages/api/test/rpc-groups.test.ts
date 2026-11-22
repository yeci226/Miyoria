// The public, member, cards, wallet, agency and fortune groups of the route table: each route says what the old route said (who may
// call it, and which method and path), and its answer loses every field the schema does not name.
// The routes' behaviour (limits, refusals, words) is held by `public.test.ts`.

import {
  type ApiOutputs,
  contract,
  FeedItemSchema,
  FeedRequestSchema,
  routeMeta,
} from "@miyoria/contracts/api";
import { FEED_ITEMS, MAX_FEED_COUNT } from "@miyoria/economy";
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
  method: "GET" | "POST" | "PUT";
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
  post("wallet.screen", "/api/member/screen", { text: "hi" }),
  { name: "wallet.danmakuView", method: "GET", path: "/api/member/danmaku", audience: "member" },
  post("wallet.danmaku", "/api/member/danmaku", { text: "hi" }),
  post("wallet.transfer", "/api/member/transfer", { to_discord_id: "1", amount: 1 }),
  post("wallet.board", "/api/member/board", { on: true }),
  { name: "wallet.boardView", method: "GET", path: "/api/member/board", audience: "member" },
  post("wallet.frame", "/api/member/frame", { buy: "sakura" }),
  { name: "wallet.quests", method: "GET", path: "/api/member/quests", audience: "member" },
  {
    name: "wallet.predictions",
    method: "GET",
    path: "/api/member/predictions",
    audience: "member",
  },
  post("wallet.bet", "/api/member/bet", { prediction: "abc123", option: "1", amount: 1 }),
  post("member.pat", "/api/member/live/pat", {}),
  { name: "member.spaces", method: "GET", path: "/api/member/spaces", audience: "member" },
  { name: "agency.bounties", method: "GET", path: "/api/member/bounties", audience: "member" },
  { name: "fortune.today", method: "GET", path: "/api/member/fortune", audience: "member" },
  { name: "cards.mine", method: "GET", path: "/api/member/cards", audience: "member" },
  { name: "cards.one", method: "GET", path: "/api/member/card/MYR-0", audience: "member" },
  { name: "cards.dex", method: "GET", path: "/api/member/cards/dex", audience: "member" },
  { name: "cards.pity", method: "GET", path: "/api/member/cards/pity", audience: "member" },
  { name: "cards.wishlist", method: "GET", path: "/api/member/cards/wishlist", audience: "member" },
  {
    name: "cards.setWishlist",
    method: "PUT",
    path: "/api/member/cards/wishlist",
    audience: "member",
    request: { json: { parts: ["hand.cat"] } },
  },
  { name: "cards.odds", method: "GET", path: "/api/public/cards/odds", audience: "public" },
  {
    name: "cards.setTitle",
    method: "PUT",
    path: "/api/member/cards/titles/glasses",
    audience: "member",
    request: { json: { public: true } },
  },
  {
    name: "cards.catalogue",
    method: "GET",
    path: "/api/member/cards/catalogue",
    audience: "member",
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
  rarity: "SR",
  parts: [{ id: "hand.cat", slot: "hand", name: "貓", rarity: "SR" }],
  expression: "微笑",
} satisfies ApiOutputs["member"]["issueCard"];

const PART = { id: "hand.cat", slot: "hand", name: "貓", rarity: "SR" } as const;
const PITY = { since: 3, pity: 30, until: 27 } satisfies ApiOutputs["cards"]["pity"];
const CHANCE = { percent: 100, shown: "100.00" };

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
} satisfies ApiOutputs["wallet"]["screen"];

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
  "public.card": { ...CARD, titles: ["眼鏡控"] } satisfies ApiOutputs["public"]["card"],
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
    prices: { card: 30, foil: null },
    balance: 12,
    pity: PITY,
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
    on_board: false,
    transfer_fee: 0.05,
  } satisfies ApiOutputs["wallet"]["view"],
  "wallet.checkin": { gained: 1, streak: 1, balance: 1 } satisfies ApiOutputs["wallet"]["checkin"],
  "wallet.feed": {
    accepted: true,
    eaten: 1,
    charged: 1,
    balance: 1,
    message: "a",
  } satisfies ApiOutputs["wallet"]["feed"],
  "wallet.screen": SPENT,
  "wallet.danmakuView": {
    open: true,
    live: false,
    currency: "魚幣",
    price: 5,
    max_chars: 30,
    cooldown_s: 20,
    per_day: 50,
    sent_today: 0,
    wait_s: 0,
    balance: 1,
    why: "a",
  } satisfies ApiOutputs["wallet"]["danmakuView"],
  "wallet.danmaku": SPENT,
  "wallet.transfer": {
    sent: 1,
    fee: 1,
    balance: 1,
    to: "a",
  } satisfies ApiOutputs["wallet"]["transfer"],
  "wallet.board": { on_board: true } satisfies ApiOutputs["wallet"]["board"],
  "wallet.boardView": {
    space: { id: "space-1", name: "a" },
    entries: [{ rank: 1, name: "a", spent: 1 }],
  } satisfies ApiOutputs["wallet"]["boardView"],
  "wallet.frame": {
    owned: ["sakura"],
    selected: null,
    balance: 1,
  } satisfies ApiOutputs["wallet"]["frame"],
  "wallet.quests": {
    currency: "魚幣",
    quests: [{ id: "her_pick", label: "a", hint: "b", done: false, by: "her" }],
    reward: 10,
    bonus: 15,
    bonus_done: false,
    earned_today: 0,
    cap: 45,
  } satisfies ApiOutputs["wallet"]["quests"],
  "wallet.predictions": {
    currency: "魚幣",
    predictions: [
      {
        id: "abc123",
        space: { id: "space-1", name: "a" },
        question: "a",
        options: [{ label: "a", staked: 1, backers: 1, multiplier: 1 }],
        total: 1,
        closes_at: "x",
        status: "resolved",
        winner: "a",
        settles: { kind: "soup", label: "b" },
        settled_by: { by: "auto", note: "c", at: "y", who: null },
        my_bet: { option: "a", amount: 1, outcome: "won", payout: 1 },
      },
    ],
  } satisfies ApiOutputs["wallet"]["predictions"],
  "wallet.bet": {
    prediction: "abc123",
    question: "a",
    option: "a",
    amount: 1,
    balance: 1,
    duplicate: false,
  } satisfies ApiOutputs["wallet"]["bet"],
  "agency.bounties": {
    bounties: [{ id: "b1", task: "a", reward: 1, posted_at: "x", expires_at: "y" }],
  } satisfies ApiOutputs["agency"]["bounties"],
  "fortune.today": { fortune: SLIP, price: 10 } satisfies ApiOutputs["fortune"]["today"],
  "member.pat": { pats: { recent: 1, open: true } } satisfies ApiOutputs["member"]["pat"],
  "member.spaces": {
    spaces: [
      {
        id: "s1",
        platform: "discord",
        external_id: "1",
        name: "Guild",
        primary: true,
        established: true,
      },
    ],
    default: "s1",
  } satisfies ApiOutputs["member"]["spaces"],
  "member.issueCard": CARD,
  "cards.mine": {
    cards: [{ ...CARD, price: 30, pity_hit: false, wished: ["hand.cat"], portrait: "live" }],
  } satisfies ApiOutputs["cards"]["mine"],
  "cards.one": {
    card: CARD,
    pity_hit: false,
    wished: ["hand.cat"],
    price: 30,
  } satisfies ApiOutputs["cards"]["one"],
  "cards.dex": {
    parts: [{ ...PART, series: "貓咪系列", count: 2, first_at: "2026-11-08T03:00:00.000Z" }],
    series: [{ id: "cats", name: "貓咪系列", title: "a", owned: 1, total: 3, complete: false }],
    titles: [{ series: "cats", title: "a", public: false, earned_at: "2026-11-08T03:00:00Z" }],
    legacy: {
      name: "舊收藏",
      items: [
        {
          item: "bg_stars",
          name: "星空",
          rarity: "R",
          series: null,
          count: 1,
          first_at: "2026-11-08T03:00:00Z",
        },
      ],
    },
  } satisfies ApiOutputs["cards"]["dex"],
  "cards.pity": PITY,
  "cards.wishlist": { parts: [PART], max: 3 } satisfies ApiOutputs["cards"]["wishlist"],
  "cards.setWishlist": { parts: [PART], max: 3 } satisfies ApiOutputs["cards"]["setWishlist"],
  "cards.odds": {
    rarities: [{ ...CHANCE, rarity: "N" }],
    pity: { after: 30, rarities: [{ ...CHANCE, rarity: "SR" }] },
    slots: [
      {
        slot: "hand",
        name: "手上",
        parts: [
          { ...CHANCE, id: "hand.cat", name: "貓", rarity: "SR", series: null, series_name: null },
        ],
        empty: null,
      },
    ],
    price: 30,
    per_day: 5,
  } satisfies ApiOutputs["cards"]["odds"],
  "cards.setTitle": {
    series: "glasses",
    title: "眼鏡控",
    public: true,
    earned_at: "2026-11-08T03:00:00.000Z",
  } satisfies ApiOutputs["cards"]["setTitle"],
  "cards.catalogue": {
    parts: [
      {
        ...PART,
        series: "cats",
        series_name: "貓咪系列",
        drop_only: false,
        blank: false,
        enabled: true,
        wishable: true,
      },
    ],
    series: [{ id: "cats", name: "貓咪系列", title: "貓奴" }],
  } satisfies ApiOutputs["cards"]["catalogue"],
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

/** The route's Hono path: `/api/public/card/MYR-0` is the `:serial` route, and so is one card. */
function pathOf(c: Case): string {
  if (c.name === "public.card") return "/api/public/card/:serial";
  if (c.name === "cards.one") return "/api/member/card/:serial";
  if (c.name === "cards.setTitle") return "/api/member/cards/titles/:series";
  return c.path;
}

describe("the answers", () => {
  // The real handlers need a running module; here each route's handler answers with more than its
  // schema says, and what leaves is the schema's.
  const os = implement({
    public: contract.public,
    member: contract.member,
    cards: contract.cards,
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
      pat: os.member.pat.handler(answer("member.pat")),
      spaces: os.member.spaces.handler(answer("member.spaces")),
    },
    cards: {
      mine: os.cards.mine.handler(answer("cards.mine")),
      one: os.cards.one.handler(answer("cards.one")),
      dex: os.cards.dex.handler(answer("cards.dex")),
      pity: os.cards.pity.handler(answer("cards.pity")),
      wishlist: os.cards.wishlist.handler(answer("cards.wishlist")),
      setWishlist: os.cards.setWishlist.handler(answer("cards.setWishlist")),
      odds: os.cards.odds.handler(answer("cards.odds")),
      setTitle: os.cards.setTitle.handler(answer("cards.setTitle")),
      catalogue: os.cards.catalogue.handler(answer("cards.catalogue")),
    },
    wallet: {
      view: os.wallet.view.handler(answer("wallet.view")),
      checkin: os.wallet.checkin.handler(answer("wallet.checkin")),
      feed: os.wallet.feed.handler(answer("wallet.feed")),
      screen: os.wallet.screen.handler(answer("wallet.screen")),
      danmakuView: os.wallet.danmakuView.handler(answer("wallet.danmakuView")),
      danmaku: os.wallet.danmaku.handler(answer("wallet.danmaku")),
      transfer: os.wallet.transfer.handler(answer("wallet.transfer")),
      board: os.wallet.board.handler(answer("wallet.board")),
      boardView: os.wallet.boardView.handler(answer("wallet.boardView")),
      frame: os.wallet.frame.handler(answer("wallet.frame")),
      quests: os.wallet.quests.handler(answer("wallet.quests")),
      predictions: os.wallet.predictions.handler(answer("wallet.predictions")),
      bet: os.wallet.bet.handler(answer("wallet.bet")),
    },
    agency: {
      bounties: os.agency.bounties.handler(answer("agency.bounties")),
    },
    fortune: {
      today: os.fortune.today.handler(answer("fortune.today")),
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
  it("allows the items and count the wallet has", () => {
    expect(FeedItemSchema.options).toEqual([...FEED_ITEMS]);
    expect(FeedRequestSchema.safeParse({ item: "rice", count: MAX_FEED_COUNT }).success).toBe(true);
    expect(FeedRequestSchema.safeParse({ item: "rice", count: MAX_FEED_COUNT + 1 }).success).toBe(
      false,
    );
  });
});
