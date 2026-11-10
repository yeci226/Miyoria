// The limits she plans with (§3.3: "把狀態寫進 Ledger 給她看"): the Arbiter's ledger when it
// runs, else the mind's own fallback floor (the self-start backoff, actions on hold). Plan sees
// them every time, so she does not plan into a wall she cannot see. Pure rendering.

import type { LedgerEntry, LedgerLimits, LedgerView, RaisedTopic } from "@miyoria/types";

/** One place where her own floor (without the Arbiter) makes her wait. */
export interface PlaceWait {
  place: string;
  /** Ms until she may start talking there again. */
  ms: number;
  /** Her starts there in a row that nobody picked up. */
  misses: number;
}

/** What Plan is shown of the limits. */
export interface PlanLimits {
  source: "arbiter" | "mind";
  limits: LedgerLimits;
  /** Recent ledger entries (newest first, bounded). */
  entries: LedgerEntry[];
  unanswered: RaisedTopic[];
  /** Without the Arbiter: where her backoff makes her wait. */
  waits: PlaceWait[];
}

const MINUTE_MS = 60_000;
const MAX_ENTRIES = 8;

function hhmm(at: string, offsetMinutes: number): string {
  const d = new Date(Date.parse(at) + offsetMinutes * MINUTE_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** The Arbiter's view as Plan sees it. */
export function fromLedger(view: LedgerView): PlanLimits {
  return {
    source: "arbiter",
    limits: view.limits,
    entries: view.entries.slice(0, MAX_ENTRIES),
    unanswered: view.unanswered,
    waits: [],
  };
}

/**
 * The limits as lines for her (trusted: numbers and times only, no names). `now` is epoch ms.
 */
export function renderLimits(p: PlanLimits, now: number, offsetMinutes: number): string[] {
  const l = p.limits;
  const lines: string[] = [];
  if (l.paused) lines.push("- 擁有者暫停了你的自主行動:現在不能主動做任何事。");
  const cap = l.initiative_cap === null ? "" : `(上限 ${l.initiative_cap})`;
  lines.push(`- 今天你主動開了 ${l.initiatives_today} 次話題${cap}`);
  if (l.unanswered_streak > 0) lines.push(`- 最近連續 ${l.unanswered_streak} 次主動開口沒人接`);
  const next = l.next_initiative_at === null ? Number.NaN : Date.parse(l.next_initiative_at);
  if (!Number.isNaN(next) && next > now) {
    lines.push(`- 下次可以主動開口:${hhmm(l.next_initiative_at as string, offsetMinutes)} 之後`);
  }
  if (l.quiet_hours) {
    const q = l.quiet_hours;
    lines.push(
      `- 安靜時段 ${q.start_hour}–${q.end_hour} 點${q.active ? ":現在就是,不要主動找人" : ""}`,
    );
  }
  for (const w of p.waits) {
    if (w.ms <= 0) continue;
    const mins = Math.max(1, Math.ceil(w.ms / MINUTE_MS));
    const misses = w.misses > 0 ? `(連續 ${w.misses} 次沒人接)` : "";
    lines.push(`- 在 ${w.place} 要再等 ${mins} 分鐘才能主動開口${misses}`);
  }
  for (const b of l.blocked) {
    const until = b.until === null ? "狀況改變前" : `${hhmm(b.until, offsetMinutes)} 前`;
    lines.push(`- ${b.capability} 暫時做不到,${until}不要再試(原因在參考資料)`);
  }
  lines.push("- 系統會照這些規則擋下你的行動;被擋下時你會在帳本看到原因。");
  return lines;
}

/** The ledger entries and reasons (data: they may name people). */
export function renderEntries(p: PlanLimits, offsetMinutes: number): string[] {
  const out = p.entries.map(
    (e) =>
      `- ${hhmm(e.at, offsetMinutes)} ${e.summary}:${e.outcome}${e.detail ? `(${e.detail})` : ""}`,
  );
  for (const b of p.limits.blocked) out.push(`- ${b.capability} 暫時做不到:${b.reason}`);
  return out;
}
