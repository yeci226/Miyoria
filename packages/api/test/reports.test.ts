// `/api/reports`: the drafts and the owner's decisions over a real `report` table and a GitHub that
// lives in memory (nothing reaches the network), each decision in the audit log.

import {
  GitHubError,
  type IssueMatch,
  type IssueState,
  type IssueTracker,
  ReportKey,
  ReportService,
  reportConfig,
  reportTables,
} from "@miyoria/brain/report";
import { contract, routeMeta } from "@miyoria/contracts/api";
import { Supervisor } from "@miyoria/runtime/kernel";
import { AuditLogKey, SqliteStore } from "@miyoria/store";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";
const T0 = Date.UTC(2026, 10, 21, 12);
const HERE = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;

const sups: Supervisor[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  for (const s of stores.splice(0)) await s.close();
});

class Issues implements IssueTracker {
  readonly opened: { title: string; body: string }[] = [];
  readonly comments: { number: number; body: string }[] = [];
  fail: GitHubError | null = null;

  async search(): Promise<IssueMatch[]> {
    return [];
  }
  async open(issue: { title: string; body: string }) {
    if (this.fail) throw this.fail;
    this.opened.push(issue);
    return {
      number: 40 + this.opened.length,
      url: `https://github.test/o/r/issues/${40 + this.opened.length}`,
    };
  }
  async comment(number: number, body: string) {
    if (number > 100) throw new GitHubError(404, "GitHub answered 404: Not Found");
    this.comments.push({ number, body });
    return { url: `https://github.test/o/r/issues/${number}#c` };
  }
  async issue(number: number): Promise<IssueState> {
    if (number > 100) throw new GitHubError(404, "GitHub answered 404: Not Found");
    return {
      number,
      state: "open",
      reason: null,
      closed_at: null,
      url: `https://github.test/o/r/issues/${number}`,
    };
  }
}

async function harness(options: { module?: boolean } = {}) {
  const store = await SqliteStore.open(":memory:", { plugins: [reportTables] });
  stores.push(store);
  const issues = new Issues();
  let ids = 0;
  const service = new ReportService({
    config: reportConfig({ token: "gh-test-token", repo: "owner/repo" }),
    store: store.plugin(reportTables),
    tracker: issues,
    now: () => T0,
    newId: () => `r${++ids}`,
  });
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  sup.services.provide("kernel", AuditLogKey, store.audit);
  if (options.module !== false) sup.services.provide("kernel", ReportKey, service);
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  const admin = (method: string, path: string, json?: unknown) =>
    raw(base, method, path, { token: TOKEN, ...(json === undefined ? {} : { json }) });
  const draft = async (title = "語音頻道裡她聽不到人說話") => {
    const outcome = await service.report({
      account: { platform: "discord", id: "111" },
      context: HERE,
      message: { context: HERE, id: `m${ids}` },
      fields: { title, happened: "講話沒有反應 @someone", expected: "聽得到", area: "voice" },
    });
    if (!outcome.ok) throw new Error("no draft");
    return outcome.id;
  };
  return { base, admin, draft, issues, store, service };
}

describe("the report routes", () => {
  it("all need the token and admin.reports.review, and are a 503 without the module", async () => {
    for (const name of ["list", "approve", "comment", "duplicate", "reject"]) {
      expect(routeMeta(contract, ["reports", name]), name).toMatchObject({
        audience: "admin",
        permission: "admin.reports.review",
      });
    }
    const h = await harness({ module: false });
    expect((await raw(h.base, "GET", "/api/reports")).status).toBe(401);
    const off = await h.admin("GET", "/api/reports");
    expect(off.status).toBe(503);
    expect(off.body).toEqual({ error: "report module is not available" });
  });

  it("lists the drafts with what an approval would send, and never the account or the place", async () => {
    const h = await harness();
    await h.draft();
    const list = await h.admin("GET", "/api/reports");
    expect(list.status).toBe(200);
    const body = list.body as {
      ready: boolean;
      repo: string;
      today: number;
      drafts: Record<string, unknown>[];
    };
    expect(body).toMatchObject({
      ready: true,
      repo: "owner/repo",
      today: 1,
      per_person_daily: 3,
      global_daily: 20,
      auto_open: false,
    });
    expect(body.drafts[0]).toMatchObject({
      id: "r1",
      status: "draft",
      place: "channel",
      issue_title: "[voice] 語音頻道裡她聽不到人說話",
    });
    expect(list.text).not.toContain("111");
    expect(list.text).not.toContain("c1");
    expect(list.text).not.toContain("@someone");
    expect(list.text).not.toContain("gh-test-token");
  });

  it("approves with edits, audits it, and refuses a second approval", async () => {
    const h = await harness();
    const id = await h.draft();
    const done = await h.admin("POST", `/api/reports/${id}/approve`, { title: "收音壞了" });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "opened", issue: { number: 41 }, decided_by: "api" });
    expect(h.issues.opened[0]?.title).toBe("收音壞了");
    const again = await h.admin("POST", `/api/reports/${id}/approve`, {});
    expect(again.status).toBe(409);
    const audit = await h.store.audit.recent(10, null);
    expect(audit.map((a) => [a.action, a.target, a.ok])).toEqual([
      ["report.approve", id, false],
      ["report.approve", id, true],
    ]);
    expect(h.issues.opened).toHaveLength(1);
  });

  it("passes GitHub's refusal on as a 502 and keeps the draft", async () => {
    const h = await harness();
    const id = await h.draft();
    h.issues.fail = new GitHubError(403, "GitHub answered 403: Resource not accessible");
    const refused = await h.admin("POST", `/api/reports/${id}/approve`, {});
    expect(refused.status).toBe(502);
    expect((await h.admin("GET", "/api/reports")).body).toMatchObject({
      drafts: [{ status: "draft", last_error: "GitHub answered 403: Resource not accessible" }],
    });
  });

  it("rejects with a reason, marks duplicates and comments on #N", async () => {
    const h = await harness();
    const a = await h.draft("一");
    const b = await h.draft("二");
    const c = await h.draft("三");
    expect((await h.admin("POST", `/api/reports/${a}/reject`, { reason: "" })).status).toBe(422);
    expect(
      (await h.admin("POST", `/api/reports/${a}/reject`, { reason: "不是問題" })).body,
    ).toMatchObject({
      status: "rejected",
      reason: "不是問題",
    });
    expect((await h.admin("POST", `/api/reports/${b}/duplicate`, { issue: 500 })).status).toBe(404);
    expect((await h.admin("POST", `/api/reports/${b}/duplicate`, { issue: 7 })).body).toMatchObject(
      {
        status: "duplicate",
        issue: { number: 7 },
      },
    );
    expect((await h.admin("POST", `/api/reports/${c}/comment`, { issue: 7 })).body).toMatchObject({
      status: "commented",
      issue: { number: 7, url: "https://github.test/o/r/issues/7#c" },
    });
    expect(h.issues.comments.map((x) => x.number)).toEqual([7]);
    expect(h.issues.opened).toEqual([]);
    expect((await h.admin("POST", "/api/reports/nope/reject", { reason: "x" })).status).toBe(404);
    const actions = (await h.store.audit.recent(20, null)).map((e) => e.action);
    expect(new Set(actions)).toEqual(
      new Set(["report.reject", "report.duplicate", "report.comment"]),
    );
  });
});
