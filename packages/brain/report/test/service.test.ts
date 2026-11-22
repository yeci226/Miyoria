// A report from her call to the issue: caps, retries, the duplicate search, the owner's decisions
// and the closure poll, on a real table and a GitHub in memory.

import { describe, expect, it } from "vitest";
import { GitHubError } from "../src/github.js";
import { REMOVED } from "../src/sanitize.js";
import { commentBody, issueBody } from "../src/service.js";
import { ALICE, BOB, FIELDS, HERE, HOUR, message, rig, STRANGER } from "./rig.js";

const report = (r: ReturnType<typeof rig>, account = ALICE, fields = FIELDS, msg = message()) =>
  r.service.report({ account, context: HERE, message: msg, fields });

describe("a report", () => {
  it("is written as a draft with who and where kept inside", async () => {
    const r = rig();
    const outcome = await report(r);
    expect(outcome).toMatchObject({ ok: true, again: false, duplicate: null, opened: null });
    const row = r.service.list(null)[0];
    expect(row).toMatchObject({
      status: "draft",
      area: "voice",
      title: FIELDS.title,
      person_id: "p-alice",
      reporter: "p-alice",
      account: ALICE,
      context: HERE,
    });
    expect(r.github.calls.filter((c) => c.startsWith("open"))).toEqual([]);
  });

  it("keeps the reporter's name, links and mentions out of what is stored", async () => {
    const r = rig();
    await report(r, ALICE, {
      ...FIELDS,
      title: "Alice Wonder 的語音 @everyone 壞了 #3",
      happened: "看 https://evil.test/x <script>alert(1)</script> 跟 <@123456789012345678>",
    });
    const row = r.service.list(null)[0];
    expect(row?.title).toBe(`${REMOVED.name} 的語音 ${REMOVED.mention} 壞了 ＃3`);
    const body = issueBody(row as NonNullable<typeof row>);
    expect(body).not.toMatch(/@|#\d|https?:|<script|Alice|123456789012345678/);
    expect(body).toContain("&lt;script&gt;");
  });

  it("refuses one with nothing in it", async () => {
    const r = rig();
    expect(
      await report(r, ALICE, { ...FIELDS, title: "  https://x.test  ", happened: "" }),
    ).toEqual({
      ok: false,
      why: "empty",
    });
    expect(r.service.list(null)).toEqual([]);
  });

  it("is one row when the call is retried", async () => {
    const r = rig();
    const msg = message("retry");
    const first = await report(r, ALICE, FIELDS, msg);
    const calls = r.github.calls.length;
    const second = await report(r, ALICE, { ...FIELDS, title: `${FIELDS.title}!` }, msg);
    expect(first.ok && second.ok && second.again && second.id === first.id).toBe(true);
    expect(r.service.list(null)).toHaveLength(1);
    // The retry asked GitHub nothing.
    expect(r.github.calls.length).toBe(calls);
  });

  it("stops at the reporter's cap, a day at a time, and counts a stranger by account", async () => {
    const r = rig({ per_person_daily: 2 });
    expect((await report(r)).ok).toBe(true);
    expect((await report(r)).ok).toBe(true);
    expect(await report(r)).toEqual({ ok: false, why: "person_cap" });
    // A retry of a counted report still answers as it did.
    expect((await report(r, BOB)).ok).toBe(true);
    expect((await report(r, STRANGER)).ok).toBe(true);
    expect(r.service.list(null).find((d) => d.reporter === "account:discord:999")).toBeTruthy();
    r.clock.now += 24 * HOUR + 1;
    expect((await report(r)).ok).toBe(true);
  });

  it("stops at the cap for everyone, before asking GitHub", async () => {
    const r = rig({ global_daily: 2 });
    await report(r, ALICE);
    await report(r, BOB);
    const searches = r.github.calls.length;
    expect(await report(r, STRANGER)).toEqual({ ok: false, why: "global_cap" });
    expect(r.github.calls.length).toBe(searches);
  });

  it("counts the cap again when it is written", async () => {
    const r = rig({ per_person_daily: 1 });
    // Two calls at once: both pass the first look, the insert lets one through.
    const [a, b] = await Promise.all([report(r), report(r)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(r.service.list(null)).toHaveLength(1);
  });

  it("records a likely duplicate from the repo's open issues", async () => {
    const r = rig();
    r.github.seed("[voice] 語音頻道裡她聽不到人");
    r.github.seed("[sing] 點歌沒有聲音");
    const outcome = await report(r);
    expect(outcome).toMatchObject({ ok: true, duplicate: { number: 1 } });
    expect(r.service.list(null)[0]).toMatchObject({
      dup_number: 1,
      dup_title: "[voice] 語音頻道裡她聽不到人",
    });
  });

  it("is still written when the search fails", async () => {
    const r = rig();
    r.github.failing.set("search", new GitHubError(403, "GitHub answered 403: rate limit"));
    expect(await report(r)).toMatchObject({ ok: true, duplicate: null });
  });

  it("opens at once with auto_open when nothing looks like it", async () => {
    const r = rig({ auto_open: true, labels: ["from-discord"] });
    const outcome = await report(r);
    expect(outcome).toMatchObject({ ok: true, opened: 1 });
    expect(r.service.list(null)[0]).toMatchObject({
      status: "opened",
      decided_by: "auto",
      issue_number: 1,
    });
    expect(r.github.issues.get(1)?.labels).toEqual(["from-discord"]);
  });

  it("waits for the owner with auto_open when it looks like a known issue", async () => {
    const r = rig({ auto_open: true });
    r.github.seed("[voice] 語音頻道裡她聽不到人說話");
    expect(await report(r)).toMatchObject({ ok: true, opened: null, duplicate: { number: 1 } });
    expect(r.service.list(null)[0]?.status).toBe("draft");
  });

  it("is refused when nothing can reach GitHub", async () => {
    const r = rig({}, { github: null });
    expect(await report(r)).toEqual({ ok: false, why: "off" });
  });
});

describe("the owner's decisions", () => {
  async function drafted() {
    const r = rig({ labels: ["bug"] });
    const outcome = await report(r);
    if (!outcome.ok) throw new Error("no draft");
    return { r, id: outcome.id };
  }

  it("approve opens the issue from the cleaned fields, with no reporter in it", async () => {
    const { r, id } = await drafted();
    const done = await r.service.approve(id, "discord:owner");
    expect(done).toMatchObject({
      ok: true,
      row: { status: "opened", issue_number: 1, decided_by: "discord:owner" },
    });
    const issue = r.github.issues.get(1);
    expect(issue?.title).toBe(`[voice] ${FIELDS.title}`);
    expect(issue?.labels).toEqual(["bug"]);
    expect(issue?.body).not.toMatch(/p-alice|111|discord:|c1|g1/);
    expect(issue?.body).toContain("### 發生了什麼");
  });

  it("approve takes the owner's edits of the title and the body", async () => {
    const { r, id } = await drafted();
    await r.service.approve(id, "api", { title: "  語音  收音壞了 ", body: "自己寫的內容" });
    expect(r.github.issues.get(1)).toMatchObject({ title: "語音 收音壞了", body: "自己寫的內容" });
  });

  it("approve writes once, however many times it is asked", async () => {
    const { r, id } = await drafted();
    const [a, b] = await Promise.all([r.service.approve(id, "api"), r.service.approve(id, "api")]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(r.github.calls.filter((c) => c.startsWith("open"))).toHaveLength(1);
    expect(await r.service.approve(id, "api")).toMatchObject({ ok: false, status: 409 });
  });

  it("a failed approval leaves the draft with the error", async () => {
    const { r, id } = await drafted();
    r.github.failing.set("open", new GitHubError(422, "GitHub answered 422: Validation Failed"));
    expect(await r.service.approve(id, "api")).toMatchObject({ ok: false, status: 502 });
    expect(r.service.get(id)).toMatchObject({
      status: "draft",
      last_error: "GitHub answered 422: Validation Failed",
      decided_by: null,
    });
  });

  it("reject keeps the reason and needs one", async () => {
    const { r, id } = await drafted();
    expect(r.service.reject(id, "api", "  ")).toMatchObject({ ok: false, status: 400 });
    expect(r.service.reject(id, "api", "不是問題")).toMatchObject({
      ok: true,
      row: { status: "rejected", reason: "不是問題" },
    });
    expect(r.github.calls.filter((c) => !c.startsWith("search"))).toEqual([]);
  });

  it("duplicate points at an existing issue without writing on GitHub", async () => {
    const { r, id } = await drafted();
    r.github.seed("old");
    expect(await r.service.duplicate(id, "api", 99)).toMatchObject({ ok: false, status: 404 });
    expect(await r.service.duplicate(id, "api", 1)).toMatchObject({
      ok: true,
      row: { status: "duplicate", issue_number: 1 },
    });
    expect(r.github.calls.some((c) => c.startsWith("open") || c.startsWith("comment"))).toBe(false);
  });

  it("comment adds the report to #N instead", async () => {
    const { r, id } = await drafted();
    r.github.seed("old");
    const done = await r.service.comment(id, "api", 1);
    expect(done).toMatchObject({ ok: true, row: { status: "commented", issue_number: 1 } });
    const row = r.service.get(id);
    expect(r.github.issues.get(1)?.comments).toEqual([commentBody(row as NonNullable<typeof row>)]);
  });

  it("comment on a missing issue leaves the draft", async () => {
    const { r, id } = await drafted();
    expect(await r.service.comment(id, "api", 5)).toMatchObject({ ok: false, status: 404 });
    expect(r.service.get(id)).toMatchObject({ status: "draft", issue_number: null });
  });

  it("an unknown draft is a 404, and nothing without GitHub is a 503", async () => {
    const { r } = await drafted();
    expect(await r.service.approve("nope", "api")).toMatchObject({ ok: false, status: 404 });
    const off = rig({}, { github: null });
    expect(await off.service.approve("nope", "api")).toMatchObject({ ok: false, status: 503 });
  });

  it("a draft left waiting on GitHub by a stop becomes a draft again, with a note", async () => {
    const { r, id } = await drafted();
    r.tables.move(id, "draft", { status: "opening" });
    expect(r.service.recover()).toBe(1);
    expect(r.service.get(id)?.status).toBe("draft");
    expect(r.service.get(id)?.last_error).toContain("GitHub");
  });
});

describe("the closure poll", () => {
  async function opened() {
    const r = rig();
    const outcome = await report(r);
    if (!outcome.ok) throw new Error("no draft");
    await r.service.approve(outcome.id, "api");
    return { r, id: outcome.id };
  }

  it("records a closed issue and queues the reporter's notice once", async () => {
    const { r, id } = await opened();
    expect(await r.service.poll()).toBe(0);
    r.github.close(1, "completed");
    expect(await r.service.poll()).toBe(1);
    expect(r.service.get(id)).toMatchObject({ close_reason: "completed" });
    expect(r.service.get(id)?.closed_at).not.toBeNull();
    expect(r.service.get(id)?.notified_at).not.toBeNull();
    expect(r.notifier.told).toEqual([
      { person: "p-alice", account: ALICE, context: HERE, area: "voice", issue: 1 },
    ]);
    // Closed rows are no longer followed.
    const calls = r.github.calls.length;
    expect(await r.service.poll()).toBe(0);
    expect(r.github.calls.length).toBe(calls);
    expect(r.notifier.told).toHaveLength(1);
  });

  it("tells nobody it was fixed when it was closed as not planned", async () => {
    const { r, id } = await opened();
    r.github.close(1, "not_planned");
    expect(await r.service.poll()).toBe(1);
    expect(r.service.get(id)).toMatchObject({ close_reason: "not_planned", notified_at: null });
    expect(r.notifier.told).toEqual([]);
  });

  it("follows a duplicate's issue too", async () => {
    const r = rig();
    const outcome = await report(r, BOB);
    if (!outcome.ok) throw new Error("no draft");
    const old = r.github.seed("old");
    await r.service.duplicate(outcome.id, "api", old.number);
    r.github.close(old.number);
    expect(await r.service.poll()).toBe(1);
    expect(r.notifier.told.map((t) => t.person)).toEqual(["p-bob"]);
  });

  it("does not mark a notice sent that could not be queued, and tells no stranger", async () => {
    const { r, id } = await opened();
    r.notifier.answer = false;
    r.github.close(1);
    await r.service.poll();
    expect(r.service.get(id)?.notified_at).toBeNull();
    const s = rig();
    const outcome = await report(s, STRANGER);
    if (!outcome.ok) throw new Error("no draft");
    await s.service.approve(outcome.id, "api");
    s.github.close(1);
    await s.service.poll();
    expect(s.notifier.told).toEqual([]);
  });

  it("keeps going past an issue it cannot read", async () => {
    const { r, id } = await opened();
    r.github.failing.set("issue", new GitHubError(0, "GitHub GET /repos: the request failed"));
    expect(await r.service.poll()).toBe(0);
    expect(r.service.get(id)?.checked_at).not.toBeNull();
    expect(r.service.get(id)?.closed_at).toBeNull();
  });
});

describe("a forgotten reporter", () => {
  it("leaves the report and takes who made it", async () => {
    const r = rig();
    await report(r, ALICE);
    await report(r, STRANGER);
    expect(r.tables.forget(["p-alice"], [STRANGER])).toBe(2);
    for (const row of r.service.list(null)) {
      expect(row).toMatchObject({ reporter: null, person_id: null, account: null, context: null });
    }
  });
});
