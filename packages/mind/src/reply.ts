// Her Plan reply as the model wrote it: JSON validated with zod, item by item, so one malformed
// part never costs the rest. Everything is bounded here (lengths, counts, durations); people,
// places and goals are still the names / context strings / goal keys she wrote and are
// resolved against the snapshot later.

import { extractJsonObject } from "@miyoria/llm";
import type { JsonObject } from "@miyoria/types";
import { z } from "zod";

export class MindReplyError extends Error {
  override readonly name = "MindReplyError";
}

/** Longest thought kept. */
export const MAX_THOUGHT = 600;
export const MAX_GOAL_ADD = 3;
export const MAX_GOAL_EDIT = 3;
export const MAX_DAY_PLAN = 600;
/** Impulses expire after 1 to 15 minutes (default 2). */
export const MIN_IMPULSE_MINS = 1;
export const MAX_IMPULSE_MINS = 15;
export const DEFAULT_IMPULSE_MINS = 2;
/** Goals last an hour to two weeks. */
export const MIN_GOAL_HOURS = 1;
export const MAX_GOAL_HOURS = 14 * 24;

/** A trigger as she wrote it (`at` relative or as a local clock time). */
export type TriggerDraft =
  | { kind: "at"; time: string | null; inMin: number | null }
  | { kind: "when_online"; person: string }
  | { kind: "after_activity"; activity: string }
  | { kind: "whenever" };

export interface GoalDraft {
  what: string;
  why: string;
  trigger: TriggerDraft;
  steps: string[];
  person: string | null;
  place: string | null;
  /** `null`: the default. */
  expiresInHours: number | null;
}

export interface GoalEditDraft {
  goal: string;
  what: string | null;
  why: string | null;
  trigger: TriggerDraft | null;
  steps: string[] | null;
  expiresInHours: number | null;
}

export interface ImpulseDraft {
  kind: "speak" | "act";
  capability: string | null;
  place: string | null;
  person: string | null;
  args: JsonObject;
  why: string;
  hint: string | null;
  goal: string | null;
  expiresInMin: number;
}

export interface PlanReply {
  thought: string;
  add: GoalDraft[];
  edit: GoalEditDraft[];
  done: string[];
  drop: { goal: string; why: string }[];
  impulses: ImpulseDraft[];
  dayPlan: string | null;
}

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const optText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((s) => (s === null || s === undefined || s.trim() === "" ? null : cut(s, max)));
const ref = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) =>
    v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim(),
  );
/** A positive number, or `null` (0, missing and garbage all mean "the default"). */
const optPositive = z
  .unknown()
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  });

/** A trigger, or `null` when it is not one. */
export function parseTrigger(value: unknown): TriggerDraft | null {
  if (typeof value === "string" && value.trim() === "whenever") return { kind: "whenever" };
  if (!isRecord(value)) return null;
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  switch (kind) {
    case "at": {
      const time = typeof value.time === "string" && value.time.trim() !== "" ? value.time : null;
      const n = Number(value.in_min);
      const inMin = Number.isFinite(n) && n > 0 ? clamp(n, 1, MAX_GOAL_HOURS * 60) : null;
      return time === null && inMin === null ? null : { kind: "at", time, inMin };
    }
    case "when_online": {
      const person = typeof value.person === "string" ? value.person.trim() : "";
      return person === "" ? null : { kind: "when_online", person };
    }
    case "after_activity": {
      const activity = typeof value.activity === "string" ? value.activity.trim() : "";
      return activity === "" ? null : { kind: "after_activity", activity: cut(activity, 40) };
    }
    case "whenever":
      return { kind: "whenever" };
    default:
      return null;
  }
}

const steps = z
  .unknown()
  .optional()
  .transform((v) =>
    Array.isArray(v)
      ? v.flatMap((s) => (typeof s === "string" && s.trim() !== "" ? [cut(s, 60)] : [])).slice(0, 6)
      : null,
  );

const GoalAdd = z.object({
  what: optText(120).refine((t) => t !== null),
  why: optText(160),
  trigger: z.unknown().optional(),
  steps,
  person: ref,
  place: ref,
  expires_in_hours: optPositive,
});

const GoalEdit = z.object({
  goal: ref.refine((v) => v !== null),
  what: optText(120),
  why: optText(160),
  trigger: z.unknown().optional(),
  steps,
  expires_in_hours: optPositive,
});

const Drop = z.object({ goal: ref.refine((v) => v !== null), why: optText(160) });

const Impulse = z.object({
  kind: z
    .string()
    .trim()
    .transform((k) => k.toLowerCase())
    .refine((k) => k === "speak" || k === "act"),
  capability: ref,
  place: ref,
  person: ref,
  args: z.unknown().optional(),
  why: optText(200),
  hint: optText(200),
  goal: ref,
  expires_in_min: optPositive,
});

/** Each item of `value` that parses; the rest are dropped. */
function items<T>(value: unknown, schema: z.ZodType<T>, max: number): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    if (out.length >= max) break;
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function refs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) =>
    (typeof v === "string" && v.trim() !== "") || typeof v === "number" ? [String(v).trim()] : [],
  );
}

const hours = (h: number | null) => (h === null ? null : clamp(h, MIN_GOAL_HOURS, MAX_GOAL_HOURS));

/** Extracts and validates her Plan reply (tolerates text around the JSON object). */
export function parsePlanReply(raw: string, maxImpulses: number): PlanReply {
  const value = extractJsonObject(raw);
  if (value === null) throw new MindReplyError("no JSON object in her plan");
  const obj = value as Record<string, unknown>;
  const thought = typeof obj.thought === "string" ? cut(obj.thought, MAX_THOUGHT) : "";
  const goals = isRecord(obj.goals) ? obj.goals : {};
  const add = items(goals.add, GoalAdd, MAX_GOAL_ADD).map((g) => ({
    what: g.what as string,
    why: g.why ?? "",
    trigger: parseTrigger(g.trigger) ?? { kind: "whenever" as const },
    steps: g.steps ?? [],
    person: g.person,
    place: g.place,
    expiresInHours: hours(g.expires_in_hours),
  }));
  const edit = items(goals.edit, GoalEdit, MAX_GOAL_EDIT).map((g) => ({
    goal: g.goal as string,
    what: g.what,
    why: g.why,
    trigger: parseTrigger(g.trigger),
    steps: g.steps === null || g.steps.length === 0 ? null : g.steps,
    expiresInHours: hours(g.expires_in_hours),
  }));
  const drop = Array.isArray(goals.drop)
    ? goals.drop.flatMap((d) => {
        if (typeof d === "string" && d.trim() !== "") return [{ goal: d.trim(), why: "" }];
        const parsed = Drop.safeParse(d);
        return parsed.success
          ? [{ goal: parsed.data.goal as string, why: parsed.data.why ?? "" }]
          : [];
      })
    : [];
  const impulses = items(obj.impulses, Impulse, Math.max(maxImpulses, 0)).map((i) => ({
    kind: i.kind as "speak" | "act",
    capability: i.capability,
    place: i.place,
    person: i.person,
    args: isRecord(i.args) ? { ...(i.args as JsonObject) } : {},
    why: i.why ?? "",
    hint: i.hint,
    goal: i.goal,
    expiresInMin: clamp(
      Math.round(i.expires_in_min ?? DEFAULT_IMPULSE_MINS),
      MIN_IMPULSE_MINS,
      MAX_IMPULSE_MINS,
    ),
  }));
  const dayPlan =
    typeof obj.day_plan === "string" && obj.day_plan.trim() !== ""
      ? cut(obj.day_plan, MAX_DAY_PLAN)
      : null;
  return { thought, add, edit, done: refs(goals.done), drop, impulses, dayPlan };
}

/** True when the reply changes nothing and asks for nothing. */
export function isEmptyPlan(reply: PlanReply): boolean {
  return (
    reply.add.length === 0 &&
    reply.edit.length === 0 &&
    reply.done.length === 0 &&
    reply.drop.length === 0 &&
    reply.impulses.length === 0 &&
    reply.dayPlan === null
  );
}
