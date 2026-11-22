// A member's GitHub link through the API: the redirect to GitHub with its cookie, the callback's
// checks, the status, the switch and unlinking; and the owner's mention switch on a draft. GitHub
// is a fake `fetch`; nothing reaches the network.

import {
  GitHubLinker,
  type IssueTracker,
  LINK_COOKIE,
  ReportKey,
  ReportService,
  ReportTables,
  reportConfig,
  reportSchema,
} from "@miyoria/brain/report";
import { contract, routeMeta } from "@miyoria/contracts/api";
import { PeopleStoreKey } from "@miyoria/store";
import { openTestDb } from "@miyoria/store/testing";
import type { AccountRef } from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { githubLinkRoutes, githubLinkRpc } from "../src/github-link.js";
import { reportsRpc } from "../src/reports.js";
import { tableRoutes } from "../src/rpc.js";
import type { ApiEnv } from "../src/state.js";

const T0 = Date.UTC(2026, 10, 21, 12);
const ALICE: AccountRef = { platform: "discord", id: "111" };
const BOB: AccountRef = { platform: "discord", id: "222" };
const PEOPLE: Record<string, string> = { "111": "p-alice", "222": "p-bob" };
const SECRET = "client-secret-TESTONLY";
const USER_TOKEN = "ghu_TESTONLY";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

const github = async (url: string, init?: RequestInit): Promise<Response> => {
  const path = new URL(url).pathname;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (path === "/login/oauth/access_token") {
    const { code } = JSON.parse(String(init?.body)) as { code: string };
    return code === "good"
      ? json({ access_token: USER_TOKEN })
      : json({ error: "bad_verification_code" });
  }
  if (path === "/user") return json({ id: 583231, login: "octocat" });
  if (path === "/applications/client-1/token") return new Response(null, { status: 204 });
  return json({ message: "Not Found" }, 404);
};

function setup() {
  const db = openTestDb({ plugins: [reportSchema] });
  closers.push(() => db.close());
  const tables = new ReportTables(db.db);
  let n = 0;
  const linker = new GitHubLinker({
    clientId: "client-1",
    clientSecret: SECRET,
    redirectUri: "https://miyoria.test/api/member/github/callback",
    store: tables,
    fetch: github,
    now: () => T0,
    random: () => `r${++n}`,
  });
  const tracker = {
    search: async () => [],
    open: async () => ({ number: 1, url: "u1" }),
    comment: async () => ({ url: "c" }),
    issue: async () => ({ number: 1, state: "open", reason: null, closed_at: null, url: "u1" }),
    login: async () => "octocat",
  } as IssueTracker;
  const reports = new ReportService({
    config: reportConfig({ repo: "owner/repo", token: "t" }),
    store: tables,
    tracker,
    now: () => T0,
    linker,
    reporter: async (a) => (PEOPLE[a.id] ? { person: PEOPLE[a.id] as string, names: [] } : null),
  });
  const audit: string[] = [];
  const state = {
    publicSide: { config: { enabled: true }, admitMember: () => null, admitHeavy: () => null },
    auth: { cookieSecure: false },
    auditAs: async (_actor: string, action: string, _t: string, detail: unknown, ok: boolean) => {
      audit.push(`${action} ${ok} ${JSON.stringify(detail)}`);
    },
    audit: async (_c: unknown, action: string, _t: string, _d: unknown, ok: boolean) => {
      audit.push(`${action} ${ok}`);
    },
    optional: (key: unknown) => {
      if (key === ReportKey) return reports;
      if (key === PeopleStoreKey) {
        return {
          personByAccount: async (a: AccountRef) => (PEOPLE[a.id] ? { id: PEOPLE[a.id] } : null),
        };
      }
      return undefined;
    },
    service: (key: unknown, what: string) => {
      if (key === ReportKey) return reports;
      throw ApiError.unavailable(`${what} is not available`);
    },
  };
  const hono = new Hono<ApiEnv>();
  const who = (c: { req: { header(n: string): string | undefined } }) =>
    c.req.header("x-test-member") === "bob" ? BOB : ALICE;
  for (const r of githubLinkRoutes(state as never)) {
    hono.on(r.method, r.path, async (c) => {
      c.set("member", { account: who(c) } as never);
      return r.handler(c);
    });
  }
  const table: AnyRouter = { githubLink: githubLinkRpc, reports: reportsRpc };
  for (const r of tableRoutes(state as never, table, { responseCheck: "strict" })) {
    hono.on(r.method, r.path, async (c) => {
      if (r.member) c.set("member", { account: who(c) } as never);
      else c.set("principal", { kind: "token" } as never);
      try {
        return await r.handler(c);
      } catch (error) {
        return error instanceof ApiError
          ? error.toResponse()
          : ApiError.internal(error).toResponse();
      }
    });
  }
  return { hono, tables, reports, audit };
}

/** Starts a link as `member`; the state GitHub would send back and the cookie the browser keeps. */
async function start(h: ReturnType<typeof setup>, member = "alice", mention = "1") {
  const res = await h.hono.request(`/api/member/github/link?mention=${mention}`, {
    headers: { "x-test-member": member },
  });
  const to = new URL(res.headers.get("location") ?? "");
  const cookie = res.headers.get("set-cookie") ?? "";
  return {
    res,
    to,
    state: to.searchParams.get("state") ?? "",
    cookie,
    binding: /=([^;]*)/.exec(cookie)?.[1] ?? "",
  };
}

const back = (
  h: ReturnType<typeof setup>,
  query: string,
  cookie: string | null,
  member = "alice",
) =>
  h.hono.request(`/api/member/github/callback?${query}`, {
    headers: {
      "x-test-member": member,
      ...(cookie === null ? {} : { cookie: `${LINK_COOKIE}=${cookie}` }),
    },
  });

describe("a member's GitHub link", () => {
  it("is a limited member route on the table, and the round trip is not", () => {
    for (const name of ["status", "mention", "unlink"]) {
      expect(routeMeta(contract, ["githubLink", name])).toEqual({
        audience: "member",
        permission: null,
        limited: true,
      });
    }
  });

  it("goes to GitHub with a short-lived HttpOnly SameSite=Lax cookie and comes back linked", async () => {
    const h = setup();
    const s = await start(h);
    expect(s.res.status).toBe(302);
    expect(s.to.origin + s.to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(s.cookie).toMatch(
      new RegExp(
        `^${LINK_COOKIE}=r2; Max-Age=600; Path=/api/member/github; HttpOnly; SameSite=Lax; Secure$`,
      ),
    );
    const res = await back(h, `state=${s.state}&code=good`, s.binding);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/me?github=linked");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    const status = await h.hono.request("/api/member/github", {
      headers: { "x-test-member": "alice" },
    });
    expect(await status.json()).toEqual({
      available: true,
      linked: { login: "octocat", mention: true, linked_at: expect.any(String) },
    });
    expect(h.audit).toContain('member.github.link true {"login":"octocat"}');
    expect(JSON.stringify(h.audit)).not.toContain(USER_TOKEN);
  });

  it("is refused for a missing cookie, a reused state, and another member's session", async () => {
    const h = setup();
    const a = await start(h);
    expect((await back(h, `state=${a.state}&code=good`, null)).headers.get("location")).toBe(
      "/me?github=state",
    );
    expect((await back(h, `state=${a.state}&code=good`, a.binding)).headers.get("location")).toBe(
      "/me?github=state",
    );
    const b = await start(h);
    expect(
      (await back(h, `state=${b.state}&code=good`, b.binding, "bob")).headers.get("location"),
    ).toBe("/me?github=state");
    expect(h.tables.linkOf("p-alice")).toBeNull();
    expect(h.tables.linkOf("p-bob")).toBeNull();
  });

  it("refuses an account already linked to someone else", async () => {
    const h = setup();
    const a = await start(h);
    await back(h, `state=${a.state}&code=good`, a.binding);
    const b = await start(h, "bob");
    expect(
      (await back(h, `state=${b.state}&code=good`, b.binding, "bob")).headers.get("location"),
    ).toBe("/me?github=taken");
    expect(h.tables.linkOf("p-bob")).toBeNull();
    expect(h.tables.linkOf("p-alice")?.login).toBe("octocat");
  });

  it("keeps the switch off when the member links without it, and lets them change it and unlink", async () => {
    const h = setup();
    const a = await start(h, "alice", "0");
    await back(h, `state=${a.state}&code=good`, a.binding);
    expect(h.tables.linkOf("p-alice")?.mention).toBe(false);
    const on = await h.hono.request("/api/member/github/mention", {
      method: "POST",
      headers: { "x-test-member": "alice", "content-type": "application/json" },
      body: JSON.stringify({ on: true }),
    });
    expect(((await on.json()) as { linked: { mention: boolean } }).linked.mention).toBe(true);
    const gone = await h.hono.request("/api/member/github/unlink", {
      method: "POST",
      headers: { "x-test-member": "alice" },
    });
    expect(await gone.json()).toEqual({ available: true, linked: null });
    expect(h.tables.linkOf("p-alice")).toBeNull();
    const none = await h.hono.request("/api/member/github/mention", {
      method: "POST",
      headers: { "x-test-member": "alice", "content-type": "application/json" },
      body: JSON.stringify({ on: true }),
    });
    expect(none.status).toBe(404);
  });
});

describe("the owner's mention switch", () => {
  it("shows whether the mention will be added, and takes it off one draft", async () => {
    const h = setup();
    h.tables.link("p-alice", 583231, "octocat", true, new Date(T0).toISOString());
    const outcome = await h.reports.report({
      account: ALICE,
      context: { platform: "discord", scope: "g", channel: "c", kind: "channel" },
      message: {
        context: { platform: "discord", scope: "g", channel: "c", kind: "channel" },
        id: "m1",
      },
      fields: { title: "語音壞了", happened: "沒有聲音", expected: "有聲音", area: "voice" },
    });
    if (!outcome.ok) throw new Error("no draft");
    const list = await h.hono.request("/api/reports");
    const body = (await list.json()) as {
      linking: boolean;
      auth: string;
      drafts: { mention: unknown }[];
    };
    expect(body).toMatchObject({ linking: true, auth: "token" });
    expect(body.drafts[0]?.mention).toEqual({ login: "octocat", will_add: true, why: "on" });
    const off = await h.hono.request(`/api/reports/${outcome.id}/mention`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: false }),
    });
    expect(((await off.json()) as { mention: unknown }).mention).toEqual({
      login: "octocat",
      will_add: false,
      why: "owner_off",
    });
    expect(h.audit).toContain("report.mention true");
  });
});
