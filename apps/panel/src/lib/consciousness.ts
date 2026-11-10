// 意識軸: EventLog lines laid on four lanes (聽到, 想, 說, 做), joined by their `cause`. Pure
// functions only; the drawing is `components/charts/consciousness-axis.tsx`.

import type { LogEvent, LogEventKind, SteerBody, SteerOutcome, ThoughtBody, TurnOutcome } from "@/api/types";
import { asE2eEvent, fmtMs } from "@/lib/e2e";
import { OUTCOME_KINDS, outcomeText, REASON_LABEL, TURN_REASON_LABEL, VERDICT_LABEL } from "@/pages/activity/labels";

export const LANES = ["聽到", "想", "說", "做"] as const;
export type Lane = 0 | 1 | 2 | 3;

export const KIND_LABEL: Record<LogEventKind, string> = {
  observation: "觀察",
  thought: "想法",
  decision: "決定",
  utterance: "要說的話",
  delivered: "送達",
  action: "動作",
  result: "結果",
  steer: "改方向",
  directive: "規則",
  proposal: "提議",
};

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const first = (r: Rec, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = text(r[k]);
    if (v) return v;
  }
  return undefined;
};
const label = <T extends string>(table: Record<T, string>, key: string | undefined): string | undefined =>
  key === undefined ? undefined : ((table as Record<string, string>)[key] ?? key);

/** What a task or an action did is 做; people and the world are 聽到. */
export function laneOf(e: LogEvent): Lane {
  switch (e.kind) {
    case "observation": {
      const key = text(rec(rec(e.body).observation).attention_key);
      return key?.startsWith("task:") ? 3 : 0;
    }
    case "thought":
    case "decision":
    case "proposal":
    case "directive":
      return 1;
    case "utterance":
    case "delivered":
      return 2;
    default:
      return 3;
  }
}

/**
 * Ambient observations (module states, who is in the channel, a song starting) are only what she
 * knows; they stay off the axis unless a person spoke or they are on the selected chain.
 */
export function isBackground(e: LogEvent): boolean {
  if (e.kind !== "observation") return false;
  const body = rec(e.body);
  const o = rec(body.observation);
  if (body.speech === true || o.addressed_to_her === true) return false;
  if (text(o.attention_key)?.startsWith("task:")) return false;
  return o.salience === "ambient";
}

export interface Described {
  /** One line, in what the log says. */
  title: string;
  /** What else is worth a line: a key, a capability, a reason. */
  detail: string | null;
}

const DELIVERY_LABEL: Record<string, string> = {
  interrupted: "被打斷",
  failed: "沒送到",
  cancelled: "沒送出",
};

const CHANNEL_LABEL: Record<string, string> = { voice: "語音", text: "文字" };

const STEER_LABEL: Record<SteerOutcome, string> = { applied: "已套用", rejected: "被拒絕", too_late: "來不及" };

/** The body of a `steer` line, or `null` when it is neither of the two shapes the Core writes. */
export function steerBody(e: LogEvent): SteerBody | null {
  const body = rec(e.body);
  if (body.phase === "request" && typeof body.why === "string") return body as unknown as SteerBody;
  if (body.phase === "outcome" && typeof body.outcome === "string" && typeof body.detail === "string") return body as unknown as SteerBody;
  return null;
}

/** The body of a `thought` line: the mind's (`thought`) or the game director's (`game.director`). */
export function thoughtBody(e: LogEvent): ThoughtBody | null {
  const body = rec(e.body);
  if (e.source === "game.director") return typeof body.game === "string" ? (body as unknown as ThoughtBody) : null;
  return typeof body.thought === "string" ? (body as unknown as ThoughtBody) : null;
}

/** A line of the log in words. Bodies are read defensively: an unknown shape falls back to its source. */
export function describe(e: LogEvent): Described {
  const body = rec(e.body);
  switch (e.kind) {
    case "observation": {
      const o = rec(body.observation);
      return { title: text(o.summary) ?? e.source, detail: text(o.attention_key) ?? null };
    }
    case "thought": {
      const t = thoughtBody(e);
      if (t === null) return { title: e.source, detail: null };
      if ("trigger" in t) {
        const goal = text(t.goal);
        const want = t.want ? `${t.want.item}${t.want.count > 1 ? `×${t.want.count}` : ""}` : null;
        const held = Array.isArray(t.held) && t.held.length > 0 ? `${t.held.length} 個方法被擋` : null;
        const extra = [want ? `要 ${want}` : null, held].filter(Boolean).join(" · ");
        return {
          title: text(t.commentary) ?? (goal ? `目標:${goal}` : (Array.isArray(t.trigger) ? text(t.trigger.join(" ")) : undefined) ?? e.source),
          detail: extra ? `${e.source} · ${extra}` : e.source,
        };
      }
      return { title: text(t.thought) ?? text(t.error) ?? e.source, detail: e.source };
    }
    case "decision": {
      if (e.source === "agent.focus") {
        const reason = label(TURN_REASON_LABEL, text(body.reason));
        return { title: `決定回應${reason ? ` · ${reason}` : ""}`, detail: null };
      }
      if (e.source === "arbiter") {
        const verdict = label(VERDICT_LABEL, text(body.verdict)) ?? "決定";
        const reason = label(REASON_LABEL, text(body.reason));
        return { title: `${verdict}${reason ? ` · ${reason}` : ""}`, detail: text(body.detail) ?? null };
      }
      const reasons = Array.isArray(body.reasons) ? body.reasons.filter((r): r is string => typeof r === "string") : [];
      return { title: body.respond === false ? "略過" : body.respond === true ? "回應" : "決定", detail: reasons[0] ?? null };
    }
    case "proposal":
      return {
        title: first(body, ["why", "hint", "reason", "summary", "goal", "text"]) ?? e.source,
        detail: text(body.capability) ?? e.source,
      };
    case "directive":
      return { title: first(body, ["rule", "text", "summary", "change"]) ?? "規則變更", detail: e.source };
    case "utterance":
      return { title: text(body.said) ?? e.source, detail: label(CHANNEL_LABEL, text(body.channel)) ?? null };
    case "delivered":
      return { title: text(body.said) ?? e.source, detail: `已送達${text(body.channel) ? ` · ${label(CHANNEL_LABEL, text(body.channel))}` : ""}` };
    case "action":
      return { title: text(body.capability) ?? e.source, detail: text(body.why) ?? null };
    case "steer": {
      const s = steerBody(e);
      if (s === null) return { title: "改方向", detail: null };
      if (s.phase === "request") return { title: text(s.why) ?? "改方向", detail: "已要求" };
      return { title: text(s.detail) ?? "改方向", detail: STEER_LABEL[s.outcome] ?? s.outcome };
    }
    case "result": {
      const outcome = rec(rec(body.turn_outcome).outcome);
      const type = text(outcome.type);
      if (type !== undefined) {
        const known = (OUTCOME_KINDS as readonly string[]).includes(type);
        return { title: known ? outcomeText(outcome as unknown as TurnOutcome) : type, detail: "回合結束" };
      }
      if (body.allowed === false) {
        return { title: `被擋下 · ${text(body.capability) ?? e.source}`, detail: first(body, ["reason", "why"]) ?? null };
      }
      const measured = asE2eEvent(e);
      if (measured) {
        return {
          title: measured.complete && measured.total_ms !== null ? `語音延遲 ${fmtMs(measured.total_ms)}` : "語音延遲沒量完",
          detail: "說完到第一個聲音",
        };
      }
      const state = text(body.delivery);
      if (state) return { title: DELIVERY_LABEL[state] ?? state, detail: text(body.reason) ?? null };
      return { title: first(body, ["detail", "summary", "error"]) ?? e.source, detail: null };
    }
  }
}

/** The turn a line belongs to, when its body names one. */
export function turnOf(e: LogEvent): string | null {
  const body = rec(e.body);
  return text(body.turn) ?? text(rec(body.turn_outcome).turn) ?? null;
}

export interface AxisNode {
  event: LogEvent;
  lane: Lane;
  /** ms since epoch. */
  t: number;
  title: string;
}

export interface AxisModel {
  /** Oldest first. */
  nodes: AxisNode[];
  /** `cause → event`, both on the axis. */
  links: { from: string; to: string }[];
  /** Ambient observations left off. */
  hidden: number;
}

const byTime = (a: LogEvent, b: LogEvent) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The lines inside `[t0, t1]`, minus background observations (unless in `keep`), with a link for
 * every `cause` that is on the axis too.
 */
export function buildAxis(events: readonly LogEvent[], t0: number, t1: number, keep: ReadonlySet<string> = new Set()): AxisModel {
  const seen = new Set<string>();
  const nodes: AxisNode[] = [];
  let hidden = 0;
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const t = Date.parse(event.at);
    if (!Number.isFinite(t) || t < t0 || t > t1) continue;
    if (isBackground(event) && !keep.has(event.id)) {
      hidden += 1;
      continue;
    }
    nodes.push({ event, lane: laneOf(event), t, title: describe(event).title });
  }
  nodes.sort((a, b) => a.t - b.t || (a.event.id < b.event.id ? -1 : 1));
  const on = new Set(nodes.map((n) => n.event.id));
  const links = nodes
    .filter((n) => n.event.cause !== null && on.has(n.event.cause))
    .map((n) => ({ from: n.event.cause as string, to: n.event.id }));
  return { nodes, links, hidden };
}

/** The selected line, its causes and what it caused, oldest first, each once. */
export function chainOf(selected: LogEvent, causes: readonly LogEvent[], effects: readonly LogEvent[]): LogEvent[] {
  const byId = new Map<string, LogEvent>();
  for (const e of [...causes, selected, ...effects]) byId.set(e.id, e);
  return [...byId.values()].sort(byTime);
}

/** Round clock times inside `[t0, t1]`; seconds are shown when the step is under a minute. */
export function axisTicks(t0: number, t1: number, count = 6): { t: number; label: string }[] {
  const span = t1 - t0;
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);
  const step = steps.find((s) => span / s <= count) ?? 3_600_000;
  const offset = new Date(t0).getTimezoneOffset() * 60_000;
  const withSeconds = step < 60_000;
  const out: { t: number; label: string }[] = [];
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) {
    const d = new Date(t);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    out.push({ t, label: withSeconds ? `${hm}:${String(d.getSeconds()).padStart(2, "0")}` : hm });
  }
  return out;
}

export const AXIS_RANGES = [
  { range: "1m", label: "1 分", ms: 60_000 },
  { range: "10m", label: "10 分", ms: 600_000 },
  { range: "1h", label: "1 時", ms: 3_600_000 },
] as const;

export type AxisRange = (typeof AXIS_RANGES)[number]["range"];

/** The page size of the query; the server caps it at 500. */
export const AXIS_LIMIT = 500;
