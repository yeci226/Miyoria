// `ReportService` (`ReportKey`): a member's problem report from her tool call to a GitHub issue.
//
// * `report`: cleans the fields (`sanitize.ts`), keeps a retried call to the row it made, checks
//   the reporter's and everyone's caps for the last 24 hours, searches the repository's open issues
//   for a likely duplicate, and writes a draft. With `auto_open`, a draft with no likely duplicate
//   opens at once; otherwise it waits for the owner.
// * The owner's decisions on a draft (the panel): `approve` (optionally with an edited title and
//   body) opens the issue, `comment` adds the report to an existing issue instead, `duplicate`
//   marks it as one of an existing issue without writing on GitHub, `reject` keeps a reason. Only
//   `approve` and `comment` write on GitHub. A draft is moved by compare-and-set, so a second click
//   or a second admin cannot write twice.
// * `poll`: reads back the issues reports went to; a closed one is recorded, and when it was closed
//   as done, the reporter's follow-up is queued through `ReportNotifier` (once).
//
// The issue's text is assembled here from the cleaned fields; who reported and where never leave
// the table.

import { createHash } from "node:crypto";
import {
  type AccountRef,
  type ContextKey,
  contextKeyString,
  type MessageRef,
  newId,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import type { ReportConfig } from "./config.js";
import { type IssueMatch, likelyDuplicate, searchTerms } from "./duplicates.js";
import { GitHubError, type IssueTracker, LOGIN } from "./github.js";
import type { GitHubLinker } from "./link.js";
import { LIMITS, markdownText, normalizeTitle, plainText } from "./sanitize.js";
import type { ReportStatus } from "./schema.js";
import type { GithubLink, ReportRow, ReportTables } from "./store.js";

/** What a report is about. */
export const REPORT_AREAS = [
  "voice",
  "sing",
  "karaoke",
  "chat",
  "memory",
  "economy",
  "cards",
  "market",
  "game",
  "stream",
  "panel",
  "member_page",
  "other",
] as const;
export type ReportArea = (typeof REPORT_AREAS)[number];

/** Each area as the issue and her follow-up say it. */
export const AREA_NAMES: Readonly<Record<ReportArea, string>> = {
  voice: "語音",
  sing: "唱歌",
  karaoke: "卡拉 OK",
  chat: "聊天",
  memory: "記憶",
  economy: "金幣",
  cards: "卡片",
  market: "市集",
  game: "遊戲",
  stream: "直播",
  panel: "管理面板",
  member_page: "成員頁面",
  other: "其他",
};

export function areaOf(value: string): ReportArea {
  return (REPORT_AREAS as readonly string[]).includes(value) ? (value as ReportArea) : "other";
}

/** The window the caps count over. */
export const CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Issues read back per pass. */
export const POLL_BATCH = 20;

/** What she gave the tool, in her own words of what the member said. */
export interface ReportFields {
  title: string;
  happened: string;
  expected: string;
  steps?: string | null;
  area: string;
}

export interface ReportInput {
  account: AccountRef;
  context: ContextKey;
  message: MessageRef;
  fields: ReportFields;
}

export type ReportOutcome =
  | {
      ok: true;
      id: string;
      /** The same report again (a retried call): nothing new was written. */
      again: boolean;
      duplicate: IssueMatch | null;
      /** It opened at once (`auto_open`). */
      opened: number | null;
    }
  | { ok: false; why: "off" | "empty" | "person_cap" | "global_cap" };

/** Someone the report is from, as far as she knows them. */
export interface Reporter {
  person: PersonId;
  /** Their names, to keep out of the text. */
  names: readonly string[];
}

/**
 * Why an approval would or would not name the reporter: `on`; `anonymous` (no person),
 * `not_linked`, `member_off` (their switch is off), `owner_off` (taken off this draft).
 */
export type MentionWhy = "on" | "anonymous" | "not_linked" | "member_off" | "owner_off";

/**
 * The last line of an issue whose reporter linked their GitHub account and lets it be named.
 * `login` comes from GitHub for the linked numeric id, never from anything anyone typed.
 */
export function mentionLine(login: string): string {
  if (!LOGIN.test(login)) throw new Error("not a GitHub login");
  return `回報的人:@${login}`;
}

/** What tells a reporter their problem was fixed. */
export interface FixedNotice {
  person: PersonId;
  account: AccountRef | null;
  context: ContextKey | null;
  area: ReportArea;
  issue: number;
}

export interface ReportNotifier {
  /** Queues the notice; `false` when it could not. */
  fixed(notice: FixedNotice, now: number): Promise<boolean>;
}

/** A decision refused: the HTTP status the panel gets, and why. */
export interface Refusal {
  ok: false;
  status: 400 | 404 | 409 | 502 | 503;
  message: string;
}
export type Decided = { ok: true; row: ReportRow } | Refusal;

export interface ReportServiceDeps {
  config: ReportConfig;
  store: ReportTables;
  /** `null`: no token or no repo; nothing goes to GitHub. */
  tracker: IssueTracker | null;
  now(): number;
  newId?(): string;
  /** The person behind an account, when she knows them. */
  reporter?(account: AccountRef): Promise<Reporter | null>;
  notifier?(): ReportNotifier | null;
  /** Members linking their GitHub account; `null`: the App's user authorisation is not set. */
  linker?: GitHubLinker | null;
  log?: {
    warn(obj: object, msg?: string): void;
    info(obj: object, msg?: string): void;
  };
}

const refuse = (status: Refusal["status"], message: string): Refusal => ({
  ok: false,
  status,
  message,
});

function capChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/** The title an issue gets from a report: its area, then the cleaned title. */
export function issueTitle(row: Pick<ReportRow, "area" | "title">): string {
  return `[${row.area}] ${row.title}`;
}

function section(heading: string, text: string | null): string {
  return `### ${heading}\n\n${text === null || text === "" ? "_不清楚_" : markdownText(text)}`;
}

/** The body an issue gets from a report: the cleaned fields under fixed headings. */
export function issueBody(
  row: Pick<ReportRow, "area" | "happened" | "expected" | "steps" | "created_at">,
): string {
  return [
    section("發生了什麼", row.happened),
    section("原本應該", row.expected),
    section("怎麼重現", row.steps),
    `### 範圍\n\n${AREA_NAMES[areaOf(row.area)]}(\`${areaOf(row.area)}\`)`,
    `---\n\n成員在 Discord 上的回報,由維護者審核後開立;內容是成員的描述,沒有經過驗證。回報時間 ${row.created_at.slice(0, 10)}。`,
  ].join("\n\n");
}

/** What a report adds to an existing issue. */
export function commentBody(
  row: Pick<ReportRow, "area" | "title" | "happened" | "expected" | "steps" | "created_at">,
): string {
  return [`另一位成員回報了看起來相同的問題:**${markdownText(row.title)}**`, issueBody(row)].join(
    "\n\n",
  );
}

function errorText(error: unknown): string {
  if (error instanceof GitHubError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export class ReportService {
  readonly #deps: ReportServiceDeps;

  constructor(deps: ReportServiceDeps) {
    this.#deps = deps;
  }

  get config(): ReportConfig {
    return this.#deps.config;
  }

  /** Whether reports can go to GitHub (the App or a token, and a repo). */
  get ready(): boolean {
    return this.#deps.tracker !== null;
  }

  /** How GitHub is reached: as the App, with the token, or not at all. */
  get auth(): "app" | "token" | null {
    const tracker = this.#deps.tracker;
    return tracker === null ? null : (tracker.kind ?? "token");
  }

  /** Members linking their GitHub account, when the App's user authorisation is set. */
  get linker(): GitHubLinker | null {
    return this.#deps.linker ?? null;
  }

  /** Never a secret: the config holds the key, the token and the client secret. */
  toJSON(): Record<string, unknown> {
    return { repo: this.#deps.config.repo, ready: this.ready, linking: this.linker !== null };
  }

  #now(): Timestamp {
    return toTimestamp(this.#deps.now());
  }

  /** Reports made in the last 24 hours. */
  today(): number {
    return this.#deps.store.countSince(toTimestamp(this.#deps.now() - CAP_WINDOW_MS));
  }

  async report(input: ReportInput): Promise<ReportOutcome> {
    const { config, store, tracker } = this.#deps;
    if (tracker === null) return { ok: false, why: "off" };
    let who: Reporter | null = null;
    try {
      who = (await this.#deps.reporter?.(input.account)) ?? null;
    } catch (error) {
      this.#deps.log?.warn({ err: errorText(error) }, "report: cannot look the reporter up");
    }
    const redact = who?.names ?? [];
    const area = areaOf(input.fields.area);
    const title = plainText(input.fields.title, { max: LIMITS.title, singleLine: true, redact });
    const happened = plainText(input.fields.happened, { max: LIMITS.happened, redact });
    const expected = plainText(input.fields.expected, { max: LIMITS.expected, redact });
    const steps = plainText(input.fields.steps ?? "", { max: LIMITS.steps, redact });
    if (normalizeTitle(title) === "" || normalizeTitle(happened) === "") {
      return { ok: false, why: "empty" };
    }
    const reporter = who?.person ?? `account:${input.account.platform}:${input.account.id}`;
    const dedupeKey = createHash("sha256")
      .update(
        [
          reporter,
          contextKeyString(input.message.context),
          input.message.id,
          normalizeTitle(title),
        ].join("\n"),
      )
      .digest("hex");

    const known = store.byKey(dedupeKey);
    if (known !== null) return this.#outcome(known, true);
    const now = this.#deps.now();
    const caps = {
      since: toTimestamp(now - CAP_WINDOW_MS),
      perPerson: config.per_person_daily,
      global: config.global_daily,
    };
    // Before the search, so a refused report costs GitHub nothing; the insert counts again.
    if (store.countSince(caps.since, reporter) >= caps.perPerson) {
      return { ok: false, why: "person_cap" };
    }
    if (store.countSince(caps.since) >= caps.global) return { ok: false, why: "global_cap" };

    const duplicate = await this.#searchDuplicate(tracker, title);
    const written = store.insert(
      {
        id: this.#deps.newId?.() ?? newId(),
        dedupe_key: dedupeKey,
        area,
        title,
        happened,
        expected,
        steps: steps === "" ? null : steps,
        reporter,
        person_id: who?.person ?? null,
        account: input.account,
        context: input.context,
        created_at: toTimestamp(now),
        duplicate: duplicate === null ? null : { ...duplicate },
      },
      caps,
    );
    if (!written.ok)
      return { ok: false, why: written.cap === "person" ? "person_cap" : "global_cap" };
    if (written.again) return this.#outcome(written.row, true);
    this.#deps.log?.info({ id: written.row.id, area }, "report: a draft was written");
    if (config.auto_open && duplicate === null) {
      const opened = await this.approve(written.row.id, "auto");
      if (opened.ok) return this.#outcome(opened.row, false);
    }
    return this.#outcome(written.row, false);
  }

  #outcome(row: ReportRow, again: boolean): ReportOutcome {
    return {
      ok: true,
      id: row.id,
      again,
      duplicate:
        row.dup_number === null
          ? null
          : { number: row.dup_number, title: row.dup_title ?? "", url: row.dup_url ?? "" },
      opened: row.status === "opened" ? row.issue_number : null,
    };
  }

  async #searchDuplicate(
    tracker: IssueTracker,
    title: string,
  ): Promise<(IssueMatch & { score: number }) | null> {
    const terms = searchTerms(title);
    if (terms.length === 0) return null;
    try {
      let found = await tracker.search(terms);
      if (found.length === 0 && terms.length > 1) found = await tracker.search(terms.slice(0, 1));
      return likelyDuplicate(title, found);
    } catch (error) {
      this.#deps.log?.warn({ err: errorText(error) }, "report: the duplicate search failed");
      return null;
    }
  }

  get(id: string): ReportRow | null {
    return this.#deps.store.get(id);
  }

  list(statuses: readonly ReportStatus[] | null, limit = 200): ReportRow[] {
    return this.#deps.store.list(statuses, limit);
  }

  #draft(id: string): ReportRow | Refusal {
    const row = this.#deps.store.get(id);
    if (row === null) return refuse(404, `沒有這份回報:${id}`);
    if (row.status !== "draft") return refuse(409, `這份回報已經處理過了(${row.status})`);
    return row;
  }

  #tracker(): IssueTracker | Refusal {
    return this.#deps.tracker ?? refuse(503, "沒有設定 GitHub App 或 token,不能寫到 GitHub");
  }

  /** The member's switch for being named on their reports' issues; `false` without a link. */
  setLinkMention(person: PersonId, on: boolean): boolean {
    return this.#deps.store.setMention(person, on);
  }

  /** Removes the member's link; `false` when there was none. */
  unlink(person: PersonId): boolean {
    return this.#deps.store.unlink(person);
  }

  /** The reporter's linked account, when they have one. */
  linkOf(person: PersonId): GithubLink | null {
    return this.#deps.store.linkOf(person);
  }

  /**
   * Whether an approval of `row` would name its reporter, as far as is known before GitHub is
   * asked again: `login` is the name last read (`null`: no link).
   */
  mentionFor(row: ReportRow): { login: string | null; will_add: boolean; why: MentionWhy } {
    if (row.person_id === null) return { login: null, will_add: false, why: "anonymous" };
    const link = this.#deps.store.linkOf(row.person_id);
    if (link === null) return { login: null, will_add: false, why: "not_linked" };
    if (!link.mention) return { login: link.login, will_add: false, why: "member_off" };
    if (row.no_mention) return { login: link.login, will_add: false, why: "owner_off" };
    return { login: link.login, will_add: true, why: "on" };
  }

  /** The owner's switch for one draft: `false` takes the reporter's mention off it. */
  setMention(id: string, on: boolean, actor: string): Decided {
    const row = this.#draft(id);
    if ("ok" in row) return row;
    const done = this.#deps.store.move(id, "draft", { no_mention: !on });
    if (done === null) return refuse(409, "這份回報剛剛被處理了");
    this.#deps.log?.info({ id, mention: on, actor }, "report: the mention was switched");
    return { ok: true, row: done };
  }

  /**
   * The reporter's login as GitHub has it now, for a draft that would name them; `null` (no line)
   * when it would not, when the account is gone, or when GitHub cannot say.
   */
  async #mentionLogin(row: ReportRow, tracker: IssueTracker): Promise<string | null> {
    const { will_add } = this.mentionFor(row);
    if (!will_add || row.person_id === null || tracker.login === undefined) return null;
    const link = this.#deps.store.linkOf(row.person_id);
    if (link === null) return null;
    let login: string | null;
    try {
      login = await tracker.login(link.github_id);
    } catch (error) {
      this.#deps.log?.warn({ id: row.id, err: errorText(error) }, "report: cannot read the login");
      return null;
    }
    if (login === null || !LOGIN.test(login)) return null;
    if (login !== link.login) this.#deps.store.relogin(row.person_id, login);
    return login;
  }

  /** Opens the issue; `edits` replace the title or the body the report would get. */
  async approve(
    id: string,
    actor: string,
    edits: { title?: string | null; body?: string | null } = {},
  ): Promise<Decided> {
    const tracker = this.#tracker();
    if ("ok" in tracker) return tracker;
    const row = this.#draft(id);
    if ("ok" in row) return row;
    const title = capChars(edits.title?.trim().replace(/\s+/g, " ") || issueTitle(row), 256);
    const body = capChars(edits.body?.trim() || issueBody(row), LIMITS.body);
    const store = this.#deps.store;
    const held = store.move(id, "draft", {
      status: "opening",
      issue_title: title,
      issue_body: body,
      decided_by: actor,
      decided_at: this.#now(),
      last_error: null,
    });
    if (held === null) return refuse(409, "這份回報剛剛被處理了");
    try {
      // The reporter's own verified link, read again now: the only mention that is not inert.
      const login = await this.#mentionLogin(held, tracker);
      const sent = login === null ? body : `${body}\n\n${mentionLine(login)}`;
      const opened = await tracker.open({ title, body: sent, labels: this.#deps.config.labels });
      const done = store.move(id, "opening", {
        status: "opened",
        issue_number: opened.number,
        issue_url: opened.url,
        issue_body: sent,
      });
      this.#deps.log?.info({ id, issue: opened.number, actor }, "report: an issue was opened");
      return { ok: true, row: done ?? held };
    } catch (error) {
      store.move(id, "opening", {
        status: "draft",
        decided_by: null,
        decided_at: null,
        last_error: errorText(error),
      });
      return refuse(502, `GitHub 沒有開成:${errorText(error)}`);
    }
  }

  /** Adds the report to issue `number` instead of opening one. */
  async comment(id: string, actor: string, number: number, body?: string | null): Promise<Decided> {
    const tracker = this.#tracker();
    if ("ok" in tracker) return tracker;
    if (!Number.isInteger(number) || number < 1) return refuse(400, "issue 編號要是正整數");
    const row = this.#draft(id);
    if ("ok" in row) return row;
    const text = capChars(body?.trim() || commentBody(row), LIMITS.body);
    const store = this.#deps.store;
    const held = store.move(id, "draft", {
      status: "commenting",
      issue_number: number,
      issue_body: text,
      decided_by: actor,
      decided_at: this.#now(),
      last_error: null,
    });
    if (held === null) return refuse(409, "這份回報剛剛被處理了");
    try {
      const made = await tracker.comment(number, text);
      const done = store.move(id, "commenting", { status: "commented", issue_url: made.url });
      return { ok: true, row: done ?? held };
    } catch (error) {
      store.move(id, "commenting", {
        status: "draft",
        issue_number: null,
        decided_by: null,
        decided_at: null,
        last_error: errorText(error),
      });
      const missing = error instanceof GitHubError && error.status === 404;
      return refuse(
        missing ? 404 : 502,
        missing ? `repo 裡沒有 #${number}` : `GitHub 沒有加成:${errorText(error)}`,
      );
    }
  }

  /** Marks the report a duplicate of issue `number`; nothing is written on GitHub. */
  async duplicate(id: string, actor: string, number: number): Promise<Decided> {
    if (!Number.isInteger(number) || number < 1) return refuse(400, "issue 編號要是正整數");
    const row = this.#draft(id);
    if ("ok" in row) return row;
    let url: string | null = null;
    const tracker = this.#deps.tracker;
    if (tracker !== null) {
      try {
        url = (await tracker.issue(number)).url || null;
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) {
          return refuse(404, `repo 裡沒有 #${number}`);
        }
        return refuse(502, `讀不到 #${number}:${errorText(error)}`);
      }
    }
    const done = this.#deps.store.move(id, "draft", {
      status: "duplicate",
      issue_number: number,
      issue_url: url,
      decided_by: actor,
      decided_at: this.#now(),
      last_error: null,
    });
    return done === null ? refuse(409, "這份回報剛剛被處理了") : { ok: true, row: done };
  }

  reject(id: string, actor: string, reason: string): Decided {
    const why = plainText(reason, { max: LIMITS.reason });
    if (why === "") return refuse(400, "要寫拒絕的原因");
    const row = this.#draft(id);
    if ("ok" in row) return row;
    const done = this.#deps.store.move(id, "draft", {
      status: "rejected",
      reason: why,
      decided_by: actor,
      decided_at: this.#now(),
      last_error: null,
    });
    return done === null ? refuse(409, "這份回報剛剛被處理了") : { ok: true, row: done };
  }

  /**
   * Rows a stopped Core left while GitHub was asked go back to being drafts, with a note: the
   * issue or comment may exist, which only GitHub can say.
   */
  recover(): number {
    let n = 0;
    for (const row of this.#deps.store.unfinished()) {
      const moved = this.#deps.store.move(row.id, row.status, {
        status: "draft",
        ...(row.status === "commenting" ? { issue_number: null } : {}),
        decided_by: null,
        decided_at: null,
        last_error: "Core 在等 GitHub 回覆時停了:先到 GitHub 看看是不是已經寫上去了,再決定",
      });
      if (moved !== null) n++;
    }
    return n;
  }

  /** Reads back the followed issues; how many were found closed. */
  async poll(signal?: AbortSignal): Promise<number> {
    const tracker = this.#deps.tracker;
    if (tracker === null) return 0;
    const store = this.#deps.store;
    let closed = 0;
    for (const row of store.followed(POLL_BATCH)) {
      if (signal?.aborted) break;
      const number = row.issue_number;
      if (number === null) continue;
      try {
        const state = await tracker.issue(number);
        const now = this.#deps.now();
        store.checked(row.id, toTimestamp(now));
        if (state.state !== "closed") continue;
        const at = state.closed_at !== null ? Date.parse(state.closed_at) : Number.NaN;
        if (!store.closed(row.id, toTimestamp(Number.isNaN(at) ? now : at), state.reason)) continue;
        closed++;
        this.#deps.log?.info({ id: row.id, issue: number, reason: state.reason }, "report: closed");
        // Closed as done (or without saying): the reporter may hear it was fixed. Not planned,
        // a duplicate or anything else: recorded, and nobody is told it was fixed.
        if (state.reason === null || state.reason === "completed") await this.#tell(row, now);
      } catch (error) {
        store.checked(row.id, toTimestamp(this.#deps.now()));
        this.#deps.log?.warn(
          { id: row.id, issue: number, err: errorText(error) },
          "report: cannot read the issue back",
        );
      }
    }
    return closed;
  }

  async #tell(row: ReportRow, now: number): Promise<void> {
    if (row.person_id === null || row.notified_at !== null) return;
    const notifier = this.#deps.notifier?.() ?? null;
    if (notifier === null || row.issue_number === null) return;
    try {
      const queued = await notifier.fixed(
        {
          person: row.person_id,
          account: row.account,
          context: row.context,
          area: areaOf(row.area),
          issue: row.issue_number,
        },
        now,
      );
      if (queued) this.#deps.store.notified(row.id, toTimestamp(now));
    } catch (error) {
      this.#deps.log?.warn(
        { id: row.id, err: errorText(error) },
        "report: cannot queue the notice",
      );
    }
  }
}
