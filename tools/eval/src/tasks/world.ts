// A fake tool set for the multi-step task set: the tools she has (`web_search`, `web_read`,
// `code_run`, `notebook_read` / `notebook_write`, `workspace_*`, `remind_me`) answering from a
// small made-up world, with no network, no clock but the one given, and nothing outside memory.
// The answers are shaped like the real tools' (a failure is a failed call with a short text), but
// they are not the real tools: this checks what she does with them, not the tools themselves.

export interface Page {
  title: string;
  text: string;
  /** The page cannot be read: the reason the real tool would give. */
  error?: string;
}

export interface SearchEntry {
  /** The entry answers a query that contains any of these. */
  match: string[];
  hits: { title: string; url: string; snippet: string }[];
}

export interface WorldSeed {
  pages?: Record<string, Page>;
  search?: SearchEntry[];
  /** Notebook pages (key → text) she starts with. */
  notebook?: Record<string, string>;
  workspace?: Record<string, string>;
  reminders?: { id: string; what: string; at: string; daily?: boolean }[];
  /** "Now" as `YYYY-MM-DD HH:MM` local time. */
  now?: string;
}

export interface Reminder {
  id: string;
  what: string;
  /** Local time, `YYYY-MM-DD HH:MM`. */
  at: string;
  daily: boolean;
}

export interface CallResult {
  ok: boolean;
  text: string;
}

export const DEFAULT_NOW = "2026-11-10 18:00";

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local `YYYY-MM-DD HH:MM` → minutes since a fixed epoch (the fake world has no time zones). */
function toMinutes(local: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`bad time ${local}`);
  return (
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) / 60_000
  );
}

function fromMinutes(minutes: number): string {
  const d = new Date(minutes * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Arithmetic only: numbers, + - * / and parentheses. The fake `code_run` runs nothing else. */
export function arithmetic(source: string): number | null {
  const text = source.replace(/\s+/g, "");
  if (!/^[0-9+\-*/().]+$/.test(text)) return null;
  let at = 0;
  const peek = (): string => text[at] ?? "";
  const expr = (): number => {
    let value = term();
    while (peek() === "+" || peek() === "-") {
      const op = text[at++];
      const rhs = term();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  };
  const term = (): number => {
    let value = factor();
    while (peek() === "*" || peek() === "/") {
      const op = text[at++];
      const rhs = factor();
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  };
  const factor = (): number => {
    if (peek() === "-") {
      at++;
      return -factor();
    }
    if (peek() === "(") {
      at++;
      const value = expr();
      if (peek() !== ")") throw new Error("missing )");
      at++;
      return value;
    }
    const start = at;
    while (/[0-9.]/.test(peek())) at++;
    const n = Number(text.slice(start, at));
    if (start === at || Number.isNaN(n)) throw new Error("number expected");
    return n;
  };
  try {
    const value = expr();
    return at === text.length && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** One run's world: the state the tools change, and the tools. */
export class FakeWorld {
  readonly pages: Record<string, Page>;
  readonly searchIndex: SearchEntry[];
  readonly notebook = new Map<string, string>();
  readonly workspace = new Map<string, string>();
  reminders: Reminder[] = [];
  readonly now: string;
  #nextReminder = 1;

  constructor(seed: WorldSeed = {}) {
    this.pages = { ...(seed.pages ?? {}) };
    this.searchIndex = [...(seed.search ?? [])];
    for (const [k, v] of Object.entries(seed.notebook ?? {})) this.notebook.set(k, v);
    for (const [k, v] of Object.entries(seed.workspace ?? {})) this.workspace.set(k, v);
    this.now = seed.now ?? DEFAULT_NOW;
    for (const r of seed.reminders ?? []) {
      this.reminders.push({ id: r.id, what: r.what, at: r.at, daily: r.daily ?? false });
    }
  }

  /** The names this world's tools answer to. */
  static readonly TOOLS = [
    "web_search",
    "web_read",
    "code_run",
    "notebook_read",
    "notebook_write",
    "workspace_write",
    "workspace_read",
    "workspace_list",
    "remind_me",
  ] as const;

  call(tool: string, args: Record<string, unknown>): CallResult {
    switch (tool) {
      case "web_search":
        return this.#search(String(args.query ?? ""));
      case "web_read":
        return this.#read(String(args.url ?? ""));
      case "code_run":
        return this.#code(String(args.code ?? ""));
      case "notebook_read":
        return this.#notebookRead(args.key === undefined ? null : String(args.key));
      case "notebook_write":
        return this.#notebookWrite(String(args.key ?? ""), String(args.text ?? ""));
      case "workspace_write":
        return this.#workspaceWrite(String(args.path ?? ""), String(args.text ?? ""));
      case "workspace_read": {
        const text = this.workspace.get(String(args.path ?? ""));
        return text === undefined ? fail("沒有這個檔案") : ok(text);
      }
      case "workspace_list":
        return ok([...this.workspace.keys()].join("\n") || "工作區是空的");
      case "remind_me":
        return this.#remind(args);
      default:
        return fail(`沒有 ${tool} 這個工具`);
    }
  }

  #search(query: string): CallResult {
    const q = query.toLowerCase();
    const entry = this.searchIndex.find((e) => e.match.some((m) => q.includes(m.toLowerCase())));
    if (!entry || entry.hits.length === 0) return ok(`搜尋「${query}」沒有找到結果。`);
    const lines = entry.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`);
    return ok(`搜尋「${query}」:\n${lines.join("\n")}`);
  }

  #read(url: string): CallResult {
    const page = this.pages[url];
    if (!page) return fail("這頁讀不到");
    if (page.error !== undefined) return fail(page.error);
    return ok(`網頁 ${page.title}\n網址: ${url}\n${page.text}`);
  }

  #code(code: string): CallResult {
    const value = arithmetic(code);
    return value === null ? fail("這個沙箱只算四則運算") : ok(String(value));
  }

  #notebookRead(key: string | null): CallResult {
    if (key === null) {
      const index = [...this.notebook.keys()].map((k) => `- ${k}`).join("\n");
      return ok(index === "" ? "筆記本還是空的。" : `筆記本:\n${index}`);
    }
    const text = this.notebook.get(key);
    return text === undefined ? fail("筆記本沒有這一頁") : ok(text);
  }

  #notebookWrite(key: string, text: string): CallResult {
    if (key.trim() === "" || text.trim() === "") return fail("要有名稱和內容");
    this.notebook.set(key, text);
    return ok(`已寫入「${key}」`);
  }

  #workspaceWrite(path: string, text: string): CallResult {
    if (path.trim() === "" || path.includes("..")) return fail("路徑不對");
    this.workspace.set(path, text);
    return ok(`已存 ${path}(${[...text].length} 字)`);
  }

  #remind(args: Record<string, unknown>): CallResult {
    const action = String(args.action ?? "set");
    if (action === "list") {
      const open = this.reminders;
      return ok(
        open.length === 0
          ? "沒有在等的提醒。"
          : open.map((r) => `${r.id} ${r.at}${r.daily ? "(每天)" : ""}:${r.what}`).join("\n"),
      );
    }
    if (action === "cancel") {
      const id = String(args.id ?? "");
      const before = this.reminders.length;
      this.reminders = this.reminders.filter((r) => r.id !== id);
      return this.reminders.length < before ? ok(`取消了 ${id}`) : fail("找不到這個提醒");
    }
    const what = String(args.what ?? "").trim();
    if (what === "") return fail("要寫要提醒什麼");
    const now = toMinutes(this.now);
    let due: number;
    if (typeof args.in_minutes === "number" && args.in_minutes > 0) {
      due = now + Math.round(args.in_minutes);
    } else if (typeof args.at === "string") {
      const hm = /^(\d{1,2}):(\d{2})$/.exec(args.at.trim());
      const full = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(args.at.trim());
      if (full) due = toMinutes(args.at.trim());
      else if (hm) {
        // "HH:MM" is the next time the clock shows that.
        const day = Math.floor(now / 1440) * 1440;
        due = day + Number(hm[1]) * 60 + Number(hm[2]);
        if (due <= now) due += 1440;
      } else return fail("時間的格式不對");
    } else return fail("要給 in_minutes 或 at");
    const id = `R${this.#nextReminder++}`;
    this.reminders.push({ id, what, at: fromMinutes(due), daily: args.daily === true });
    return ok(`設好了 ${id}:${fromMinutes(due)}`);
  }
}

const ok = (text: string): CallResult => ({ ok: true, text });
const fail = (text: string): CallResult => ({ ok: false, text });
