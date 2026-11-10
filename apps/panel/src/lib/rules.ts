// The owner's rules as the panel shows them (docs/design/v3-architecture.md §9): labels, how a rule
// ends, and which rule stopped what. The log keeps no rule id on what a rule stopped, only the
// reason the service wrote (`<權限>定的規則:<內容>`), so a stop is matched to a rule by that text.

import type { DirectiveAuthority, DirectiveEffect, DirectiveRecord, DirectiveScope, LogEvent } from "@/api/types";
import { accountString, contextShort, fmtDateTime, fmtTime } from "./format";

export const AUTHORITY_LABEL: Record<DirectiveAuthority, string> = {
  owner: "主人",
  moderator: "管理員",
  system: "系統",
  viewer: "觀眾",
};

export const EFFECT_LABEL: Record<DirectiveEffect, string> = {
  deny: "禁止",
  require_approval: "需要核准",
  prefer: "偏好",
  avoid: "避免",
};

export const EFFECTS: DirectiveEffect[] = ["deny", "require_approval", "prefer", "avoid"];

/** Only these are enforced; the other two are told to her and nothing more. */
export const enforced = (effect: DirectiveEffect): boolean => effect === "deny" || effect === "require_approval";

/** Where a rule applies, one short phrase per narrowing; `全部` when nothing narrows it. */
export function scopeParts(scope: DirectiveScope): { kind: "capability" | "activity" | "context" | "person"; text: string }[] {
  const out: { kind: "capability" | "activity" | "context" | "person"; text: string }[] = [];
  if (scope.capability) out.push({ kind: "capability", text: scope.capability });
  if (scope.activity) out.push({ kind: "activity", text: scope.activity });
  if (scope.person) out.push({ kind: "person", text: scope.person });
  if (scope.context) out.push({ kind: "context", text: contextShort(scope.context) });
  return out;
}

/** Where the rule came from, in words: the issuer's account and what it was made from. */
export function sourceOf(rule: Pick<DirectiveRecord, "source_event" | "issuer">): string {
  const s = rule.source_event;
  const who = accountString(rule.issuer);
  if (s.startsWith("panel:")) return `面板 · ${s.slice("panel:".length)}`;
  if (s.startsWith("command:")) return `指令 /${s.slice("command:".length).replaceAll(".", " ")} · ${who}`;
  if (s.startsWith("msg:")) return `訊息 · ${who}`;
  return `對話 · ${who}`;
}

/** `解除前有效`, or when it stops: the time today, the date after that. */
export function expiryLabel(rule: Pick<DirectiveRecord, "expires">, now = Date.now()): string {
  if (rule.expires === "until_revoked") return "解除前有效";
  const t = Date.parse(rule.expires);
  if (Number.isNaN(t)) return rule.expires;
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString();
  return `${sameDay ? fmtTime(rule.expires) : fmtDateTime(rule.expires)} 止`;
}

/** Whether `rule` is still in force at `now`. */
export function inForce(rule: DirectiveRecord, now: number): boolean {
  if (rule.revoked_at !== null) return false;
  return rule.expires === "until_revoked" || Date.parse(rule.expires) > now;
}

/** A rule that was stopped, and by what. */
export interface Block {
  id: string;
  at: string;
  /** The capability she tried, when it was an action. */
  capability: string | null;
  /** What she wanted it for, or what a dropped proposal said. */
  what: string | null;
  /** The reason the service wrote. */
  reason: string;
  /** The rule in it, when the reason names one. */
  rule: { authority: string; text: string } | null;
  turn: string | null;
  via: "action" | "proposal";
}

const RULE = /^(主人|管理員|系統|觀眾)定的規則:([\s\S]*)$/;
const DROPPED = /^提案作廢:([\s\S]*)\(((?:主人|管理員|系統|觀眾)定的規則:[\s\S]*)\)$/;

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function ruleIn(reason: string): Block["rule"] {
  const m = RULE.exec(reason);
  return m ? { authority: m[1] as string, text: m[2] as string } : null;
}

/**
 * What a rule stopped, from the `gate` results the actuator wrote (stage `directive`) and the
 * proposals the rules dropped. Newest first as given.
 */
export function blocksOf(events: LogEvent[]): Block[] {
  const out: Block[] = [];
  for (const e of events) {
    const o = record(e.body);
    if (e.kind === "result" && e.source === "gate") {
      if (o.allowed !== false || o.stage !== "directive") continue;
      const reason = typeof o.reason === "string" ? o.reason : "";
      out.push({
        id: e.id,
        at: e.at,
        capability: typeof o.capability === "string" ? o.capability : null,
        what: typeof o.why === "string" && o.why !== "" ? o.why : null,
        reason,
        rule: ruleIn(reason),
        turn: typeof o.turn === "string" ? o.turn : null,
        via: "action",
      });
    } else if (e.kind === "directive" && o.op === "proposal_dropped") {
      const text = typeof o.text === "string" ? o.text : "";
      const m = DROPPED.exec(text);
      const reason = m ? (m[2] as string) : text;
      out.push({
        id: e.id,
        at: e.at,
        capability: null,
        what: m ? (m[1] as string) : text.replace(/^提案作廢:/, ""),
        reason,
        rule: ruleIn(reason),
        turn: null,
        via: "proposal",
      });
    }
  }
  return out;
}

/** How many of `blocks` each rule made, by rule id. Two rules that read the same share the count. */
export function blocksPerRule(rules: DirectiveRecord[], blocks: Block[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const rule of rules) {
    const label = AUTHORITY_LABEL[rule.authority];
    out.set(rule.id, blocks.filter((b) => b.rule?.authority === label && b.rule.text === rule.text).length);
  }
  return out;
}

/** Midnight of the local day of `now`, ms. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
