// A member links their own GitHub account: the OAuth round trip, the state's checks, one person per
// account, unlinking and forgetting, and the reporter's mention on the issue. `fetch` is a fake;
// nothing reaches GitHub.

import { openTestDb } from "@miyoria/store/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../src/http.js";
import { GitHubLinker, LINK_TTL_MS } from "../src/link.js";
import { reportSchema } from "../src/migrations.js";
import { ReportTables, reportTables } from "../src/store.js";
import { ALICE, BOB, FIELDS, HERE, message, rig, T0 } from "./rig.js";

const CLIENT_SECRET = "client-secret-TESTONLY";
const USER_TOKEN = "ghu_user_token_TESTONLY";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

interface Sent {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** GitHub's OAuth endpoints: code `good` is octocat (id 583231), `other` is hubot (id 99). */
function oauth() {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers as Record<string, string>);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    sent.push({ method, url, authorization: headers.get("authorization"), body });
    const path = new URL(url).pathname;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/login/oauth/access_token") {
      const code = (body as { code: string }).code;
      if (code === "good") return json({ access_token: USER_TOKEN, token_type: "bearer" });
      if (code === "other") return json({ access_token: `${USER_TOKEN}-2`, token_type: "bearer" });
      return json({ error: "bad_verification_code" });
    }
    if (path === "/user") {
      const auth = headers.get("authorization");
      if (auth === `Bearer ${USER_TOKEN}`) return json({ id: 583231, login: "octocat" });
      if (auth === `Bearer ${USER_TOKEN}-2`) return json({ id: 99, login: "hubot" });
      return json({ message: "Bad credentials" }, 401);
    }
    if (method === "DELETE" && path === "/applications/client-1/token")
      return new Response(null, { status: 204 });
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, sent };
}

function setup() {
  const db = openTestDb({ plugins: [reportSchema] });
  closers.push(() => db.close());
  const tables = new ReportTables(db.db);
  const gh = oauth();
  const clock = { now: T0 };
  let n = 0;
  const linker = new GitHubLinker({
    clientId: "client-1",
    clientSecret: CLIENT_SECRET,
    redirectUri: "https://miyoria.test/api/member/github/callback",
    store: tables,
    fetch: gh.fetch,
    now: () => clock.now,
    random: () => `rand${++n}`,
  });
  return { tables, linker, gh, clock, db };
}

describe("linking a GitHub account", () => {
  it("goes to GitHub with the exact callback and no scope, and keeps only the id and the login", async () => {
    const s = setup();
    const { url, binding } = s.linker.begin("p-alice", ALICE, true);
    const to = new URL(url);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://miyoria.test/api/member/github/callback",
    );
    expect(to.searchParams.get("client_id")).toBe("client-1");
    expect(to.searchParams.get("scope")).toBeNull();
    const state = to.searchParams.get("state");
    const done = await s.linker.finish({
      state,
      binding,
      code: "good",
      error: null,
      account: ALICE,
    });
    expect(done).toEqual({ ok: true, login: "octocat", replaced: false });
    const row = s.tables.linkOf("p-alice");
    expect(row).toMatchObject({
      person_id: "p-alice",
      github_id: 583231,
      login: "octocat",
      mention: true,
    });
    // The user token was used for `GET /user` only, then revoked; it is stored nowhere.
    expect(s.gh.sent.map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual([
      "POST /login/oauth/access_token",
      "GET /user",
      "DELETE /applications/client-1/token",
    ]);
    expect(s.gh.sent[0]?.body).toMatchObject({
      redirect_uri: "https://miyoria.test/api/member/github/callback",
    });
    const everything = JSON.stringify(s.db.db.all("SELECT * FROM report_github_links"));
    expect(everything).not.toContain(USER_TOKEN);
    expect(JSON.stringify(s.linker)).not.toContain(CLIENT_SECRET);
  });

  it("keeps the member's choice not to be named", async () => {
    const s = setup();
    const { url, binding } = s.linker.begin("p-alice", ALICE, false);
    await s.linker.finish({
      state: new URL(url).searchParams.get("state"),
      binding,
      code: "good",
      error: null,
      account: ALICE,
    });
    expect(s.tables.linkOf("p-alice")?.mention).toBe(false);
  });

  it("refuses a missing, wrong, reused or expired state, another session and another browser", async () => {
    const s = setup();
    const start = () => {
      const { url, binding } = s.linker.begin("p-alice", ALICE, true);
      return { state: new URL(url).searchParams.get("state"), binding };
    };
    const finish = (state: string | null, binding: string | null, account = ALICE) =>
      s.linker.finish({ state, binding, code: "good", error: null, account });
    const a = start();
    expect(await finish(null, a.binding)).toEqual({ ok: false, why: "state" });
    expect(await finish("made-up", a.binding)).toEqual({ ok: false, why: "state" });
    // The wrong browser (no or another cookie) uses the state up.
    expect(await finish(a.state, null)).toEqual({ ok: false, why: "state" });
    expect(await finish(a.state, a.binding)).toEqual({ ok: false, why: "state" });
    const b = start();
    expect(await finish(b.state, "rand-wrong")).toEqual({ ok: false, why: "state" });
    const c = start();
    expect(await finish(c.state, c.binding, BOB)).toEqual({ ok: false, why: "state" });
    const d = start();
    s.clock.now += LINK_TTL_MS;
    expect(await finish(d.state, d.binding)).toEqual({ ok: false, why: "state" });
    const e = start();
    expect(await finish(e.state, e.binding)).toMatchObject({ ok: true });
    expect(await finish(e.state, e.binding)).toEqual({ ok: false, why: "state" });
    // Nothing reached GitHub for the refused ones.
    expect(s.gh.sent.filter((x) => x.url.endsWith("/access_token"))).toHaveLength(1);
  });

  it("says when the member said no on GitHub, or GitHub would not say who they are", async () => {
    const s = setup();
    const one = s.linker.begin("p-alice", ALICE, true);
    expect(
      await s.linker.finish({
        state: new URL(one.url).searchParams.get("state"),
        binding: one.binding,
        code: null,
        error: "access_denied",
        account: ALICE,
      }),
    ).toEqual({ ok: false, why: "cancelled" });
    const two = s.linker.begin("p-alice", ALICE, true);
    expect(
      await s.linker.finish({
        state: new URL(two.url).searchParams.get("state"),
        binding: two.binding,
        code: "bad",
        error: null,
        account: ALICE,
      }),
    ).toEqual({ ok: false, why: "exchange" });
    expect(s.tables.linkOf("p-alice")).toBeNull();
  });

  it("refuses an account linked to someone else, and replaces one's own", async () => {
    const s = setup();
    const link = async (person: string, account = ALICE, code = "good") => {
      const { url, binding } = s.linker.begin(person, account, true);
      return s.linker.finish({
        state: new URL(url).searchParams.get("state"),
        binding,
        code,
        error: null,
        account,
      });
    };
    expect(await link("p-alice")).toMatchObject({ ok: true });
    expect(await link("p-bob", BOB)).toEqual({ ok: false, why: "taken" });
    expect(s.tables.linkOf("p-bob")).toBeNull();
    expect(s.tables.linkOf("p-alice")?.github_id).toBe(583231);
    expect(await link("p-alice", ALICE, "other")).toEqual({
      ok: true,
      login: "hubot",
      replaced: true,
    });
    expect(s.tables.linkOf("p-alice")?.github_id).toBe(99);
    // octocat is free again.
    expect(await link("p-bob", BOB)).toMatchObject({ ok: true });
  });

  it("goes when the member unlinks or asks to be forgotten, and moves with a merge", async () => {
    const s = setup();
    s.tables.link("p-alice", 1, "one", true, new Date(T0).toISOString());
    s.tables.link("p-bob", 2, "two", true, new Date(T0).toISOString());
    expect(s.tables.unlink("p-alice")).toBe(true);
    expect(s.tables.linkOf("p-alice")).toBeNull();
    const opened = reportTables.open({ db: s.db.db } as never);
    const forgot = reportTables.forgetPerson?.(opened, {
      person: "p-bob",
      ids: ["p-bob"],
      accounts: [BOB],
      reason: "forget me",
      source: "memory",
    });
    expect(forgot?.declined).toBeUndefined();
    expect(s.tables.linkOf("p-bob")).toBeNull();
    s.tables.link("p-carol", 3, "three", true, new Date(T0).toISOString());
    s.tables.merge("p-alice", "p-carol");
    expect(s.tables.linkOf("p-alice")?.github_id).toBe(3);
  });
});

describe("the reporter's mention on the issue", () => {
  async function drafted(link: { mention: boolean } | null, person = ALICE) {
    const r = rig();
    if (link !== null)
      r.tables.link(
        person === ALICE ? "p-alice" : "p-bob",
        583231,
        "octocat",
        link.mention,
        new Date(T0).toISOString(),
      );
    const outcome = await r.service.report({
      account: person,
      context: HERE,
      message: message(),
      fields: FIELDS,
    });
    if (!outcome.ok) throw new Error("no draft");
    return { r, id: outcome.id };
  }

  it("is the body's last line for a linked reporter who allows it, with the login GitHub has now", async () => {
    const { r, id } = await drafted({ mention: true });
    r.github.users.set(583231, "octo-renamed");
    expect(r.service.mentionFor(r.service.get(id) as never)).toEqual({
      login: "octocat",
      will_add: true,
      why: "on",
    });
    await r.service.approve(id, "api");
    const body = r.github.issues.get(1)?.body ?? "";
    expect(body.split("\n").at(-1)).toBe("回報的人:@octo-renamed");
    expect(body.match(/@/g)).toHaveLength(1);
    expect(r.tables.linkOf("p-alice")?.login).toBe("octo-renamed");
  });

  it("is added after the owner's own edit of the body", async () => {
    const { r, id } = await drafted({ mention: true });
    r.github.users.set(583231, "octocat");
    await r.service.approve(id, "api", { body: "自己寫的內容" });
    expect(r.github.issues.get(1)?.body).toBe("自己寫的內容\n\n回報的人:@octocat");
  });

  it("is not there for someone unlinked, someone who turned it off, or a draft the owner took it off", async () => {
    const unlinked = await drafted(null);
    await unlinked.r.service.approve(unlinked.id, "api");
    expect(unlinked.r.github.issues.get(1)?.body).not.toContain("回報的人");

    const off = await drafted({ mention: false });
    off.r.github.users.set(583231, "octocat");
    expect(off.r.service.mentionFor(off.r.service.get(off.id) as never)).toMatchObject({
      will_add: false,
      why: "member_off",
    });
    await off.r.service.approve(off.id, "api");
    expect(off.r.github.issues.get(1)?.body).not.toContain("@");

    const removed = await drafted({ mention: true });
    removed.r.github.users.set(583231, "octocat");
    expect(removed.r.service.setMention(removed.id, false, "api")).toMatchObject({
      ok: true,
      row: { no_mention: true },
    });
    expect(removed.r.service.mentionFor(removed.r.service.get(removed.id) as never)).toMatchObject({
      will_add: false,
      why: "owner_off",
    });
    await removed.r.service.approve(removed.id, "api");
    expect(removed.r.github.issues.get(1)?.body).not.toContain("@");
  });

  it("is left out when the account is gone, or GitHub cannot say who it is now", async () => {
    const gone = await drafted({ mention: true });
    await gone.r.service.approve(gone.id, "api");
    expect(gone.r.github.issues.get(1)?.body).not.toContain("@");

    const down = await drafted({ mention: true });
    down.r.github.users.set(583231, "octocat");
    down.r.github.failing.set(
      "login",
      Object.assign(new Error("GitHub GET /user/583231: the request failed"), {
        status: 0,
      }) as never,
    );
    expect((await down.r.service.approve(down.id, "api")).ok).toBe(true);
    expect(down.r.github.issues.get(1)?.body).not.toContain("@");
  });

  it("follows the member's switch at approval, not when they reported", async () => {
    const { r, id } = await drafted({ mention: true });
    r.github.users.set(583231, "octocat");
    r.tables.setMention("p-alice", false);
    await r.service.approve(id, "api");
    expect(r.github.issues.get(1)?.body).not.toContain("@");
  });
});
