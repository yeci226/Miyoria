// A real `report_drafts` table (SQLite in memory), a GitHub that lives in memory, a clock the test
// moves, and a notifier that writes down what it was asked. Nothing here reaches the network.

import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { AccountRef, ContextKey, MessageRef } from "@miyoria/types";
import { afterEach } from "vitest";
import { type ReportConfig, reportConfig } from "../src/config.js";
import type { IssueMatch } from "../src/duplicates.js";
import { GitHubError, type IssueState, type IssueTracker } from "../src/github.js";
import { reportSchema } from "../src/migrations.js";
import {
  type FixedNotice,
  type Reporter,
  type ReportFields,
  type ReportNotifier,
  ReportService,
} from "../src/service.js";
import { ReportTables } from "../src/store.js";

/** 2026-11-21 12:00 UTC. */
export const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);
export const HOUR = 60 * 60 * 1000;

export const ALICE: AccountRef = { platform: "discord", id: "111" };
export const BOB: AccountRef = { platform: "discord", id: "222" };
export const STRANGER: AccountRef = { platform: "discord", id: "999" };
export const HERE: ContextKey = {
  platform: "discord",
  scope: "g1",
  channel: "c1",
  kind: "channel",
};

const PEOPLE: Record<string, Reporter> = {
  "111": { person: "p-alice", names: ["Alice Wonder", "alice_w"] },
  "222": { person: "p-bob", names: ["Bob"] },
};

let messages = 0;
/** A fresh message in `HERE`. */
export function message(id = `m${++messages}`): MessageRef {
  return { context: HERE, id };
}

export const FIELDS: ReportFields = {
  title: "語音頻道裡她聽不到人說話",
  happened: "進語音以後講話她都沒有反應",
  expected: "她應該聽得到並且回話",
  steps: "1. 進語音頻道\n2. 開口說話",
  area: "voice",
};

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  reason: string | null;
  comments: string[];
}

/** GitHub in memory: issues by number, every call written down, failures on demand. */
export class FakeGitHub implements IssueTracker {
  readonly issues = new Map<number, FakeIssue>();
  readonly calls: string[] = [];
  /** Logins by numeric id, for `login`. */
  readonly users = new Map<number, string>();
  /** The next calls of this kind throw it. */
  readonly failing = new Map<string, GitHubError>();
  #next = 1;

  seed(title: string, state: "open" | "closed" = "open"): FakeIssue {
    const issue: FakeIssue = {
      number: this.#next++,
      title,
      body: "",
      labels: [],
      state,
      reason: state === "closed" ? "completed" : null,
      comments: [],
    };
    this.issues.set(issue.number, issue);
    return issue;
  }

  close(number: number, reason: string | null = "completed"): void {
    const issue = this.issues.get(number);
    if (issue === undefined) throw new Error(`no #${number}`);
    issue.state = "closed";
    issue.reason = reason;
  }

  #fail(kind: string): void {
    const error = this.failing.get(kind);
    if (error !== undefined) throw error;
  }

  async search(terms: readonly string[]): Promise<IssueMatch[]> {
    this.calls.push(`search ${terms.join(" ")}`);
    this.#fail("search");
    return [...this.issues.values()]
      .filter((i) => i.state === "open" && terms.every((t) => i.title.toLowerCase().includes(t)))
      .map((i) => ({
        number: i.number,
        title: i.title,
        url: `https://github.test/o/r/issues/${i.number}`,
      }));
  }

  async open(issue: { title: string; body: string; labels: readonly string[] }) {
    this.calls.push(`open ${issue.title}`);
    this.#fail("open");
    const made = this.seed(issue.title);
    made.body = issue.body;
    made.labels = [...issue.labels];
    return { number: made.number, url: `https://github.test/o/r/issues/${made.number}` };
  }

  async comment(number: number, body: string) {
    this.calls.push(`comment ${number}`);
    this.#fail("comment");
    const issue = this.issues.get(number);
    if (issue === undefined) throw new GitHubError(404, "GitHub answered 404: Not Found");
    issue.comments.push(body);
    return {
      url: `https://github.test/o/r/issues/${number}#issuecomment-${issue.comments.length}`,
    };
  }

  async login(id: number): Promise<string | null> {
    this.calls.push(`login ${id}`);
    this.#fail("login");
    return this.users.get(id) ?? null;
  }

  async issue(number: number): Promise<IssueState> {
    this.calls.push(`issue ${number}`);
    this.#fail("issue");
    const issue = this.issues.get(number);
    if (issue === undefined) throw new GitHubError(404, "GitHub answered 404: Not Found");
    return {
      number,
      state: issue.state,
      reason: issue.reason,
      closed_at: issue.state === "closed" ? new Date(T0).toISOString() : null,
      url: `https://github.test/o/r/issues/${number}`,
    };
  }
}

export class FakeNotifier implements ReportNotifier {
  readonly told: FixedNotice[] = [];
  answer = true;

  async fixed(notice: FixedNotice): Promise<boolean> {
    this.told.push(notice);
    return this.answer;
  }
}

const dbs: TestDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

export interface Rig {
  service: ReportService;
  tables: ReportTables;
  github: FakeGitHub;
  notifier: FakeNotifier;
  config: ReportConfig;
  clock: { now: number };
}

export function rig(
  config: Partial<ReportConfig> = {},
  options: { github?: FakeGitHub | null } = {},
): Rig {
  const db = openTestDb({ plugins: [reportSchema] });
  dbs.push(db);
  const tables = new ReportTables(db.db);
  const github = options.github === undefined ? new FakeGitHub() : options.github;
  const notifier = new FakeNotifier();
  const clock = { now: T0 };
  const full = reportConfig({ token: "test-token", repo: "owner/repo", ...config });
  let ids = 0;
  const service = new ReportService({
    config: full,
    store: tables,
    tracker: github,
    now: () => clock.now,
    newId: () => `r${String(++ids).padStart(3, "0")}`,
    reporter: async (account) => PEOPLE[account.id] ?? null,
    notifier: () => notifier,
  });
  return { service, tables, github: github ?? new FakeGitHub(), notifier, config: full, clock };
}
