// What the journal keeps of one Plan's input and reasoning for the panel: bounded copies of
// the prompt's data (the strings cut, the lists capped), and only for the newest thoughts.

import type { ThoughtEffects, ThoughtInput } from "@miyoria/types";
import { describeTrigger, goalKey } from "./goals.js";
import type { PlanInput } from "./prompt.js";

/** Thoughts that keep their input snapshot and reasoning; older ones drop them. */
export const DETAIL_KEEP = 40;
/** Characters kept of each long text of the snapshot (world, memories, documents, recap). */
export const TEXT_CHARS = 6_000;
/** Characters kept of the model's reasoning. */
export const REASONING_CHARS = 12_000;
const LIST_MAX = 40;
const LINE_CHARS = 400;

function cut(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  return text.length > max ? `${text.slice(0, max)}…(還有 ${text.length - max} 字)` : text;
}

const line = (text: string) => cut(text, LINE_CHARS) ?? "";

/** The bounded snapshot of what `input` showed her. */
export function thoughtInput(input: PlanInput): ThoughtInput {
  const a = input.affect;
  const s = input.self;
  const self: ThoughtInput["self"] =
    a !== null
      ? {
          mood: { ...a.mood },
          boredom: a.boredom,
          drives: { ...a.drives },
          initiative: a.biases.initiative,
          emotions: Object.fromEntries(a.top.map((e) => [e.name, e.intensity])),
          shown: a.shown ? `${a.shown.style} <emo:${a.shown.tag}>` : null,
        }
      : s
        ? {
            mood: s.mood ? { ...s.mood } : null,
            boredom: s.boredom,
            drives: { ...s.drives },
            initiative: s.policy.initiative,
            emotions: Object.fromEntries((s.emotions ?? []).map((e) => [e.name, e.intensity])),
            shown: s.shown ? `${s.shown.style} <emo:${s.shown.tag}>` : null,
          }
        : null;
  const ledger = input.limits.entries.map((e) => line(`${e.summary}:${e.outcome}`));
  return {
    time: input.time,
    night: input.limits.limits.quiet_hours?.active ?? false,
    self,
    suggestions: input.suggestions.slice(0, LIST_MAX).map((x) => ({ ...x, hint: line(x.hint) })),
    world: cut(input.world, TEXT_CHARS) ?? "",
    places: input.places.slice(0, LIST_MAX).map((p) => ({
      ref: p.ref,
      label: line(p.label),
      note: line(p.note),
      here: p.here,
    })),
    people: input.people.slice(0, LIST_MAX).map((p) => ({
      ref: p.ref,
      name: line(p.name),
      person: p.person,
      relation: p.relation,
      feeling: p.feeling === null ? null : line(p.feeling),
      doing: p.doing === null ? null : line(p.doing),
      heart: p.heart ?? null,
    })),
    agenda: input.goals.slice(0, LIST_MAX).map((g) => ({
      ref: goalKey(g),
      text: line(`${g.what}(${describeTrigger(g.trigger, input.utcOffsetMinutes)})`),
      due: g.trigger.kind === "at" ? g.trigger.time : null,
      blocked: null,
    })),
    memories: cut(input.memories, TEXT_CHARS),
    documents: cut(input.documents ?? null, TEXT_CHARS),
    lessons: (input.lessons ?? []).slice(0, LIST_MAX).map(line),
    recap: cut(input.recap ?? null, TEXT_CHARS),
    digest: cut(input.digest ?? null, TEXT_CHARS),
    unanswered: [...(input.unanswered ?? []), ...ledger].slice(0, LIST_MAX).map(line),
    blocked: [
      ...(input.blocked ?? []),
      ...input.limits.limits.blocked.map((b) => ({ capability: b.capability, reason: b.reason })),
    ]
      .slice(0, LIST_MAX)
      .map((b) => ({ capability: b.capability, reason: line(b.reason) })),
    idle: null,
    capabilities: input.capabilities.map((c) => c.name),
    recent: input.recent.length,
  };
}

export function clipReasoning(text: string): string | null {
  const t = text.trim();
  return t === "" ? null : cut(t, REASONING_CHARS);
}

export function noEffects(): ThoughtEffects {
  return {
    drives: {},
    talkativeness: [],
    initiative: null,
    feelings: [],
    agenda_added: [],
    agenda_done: [],
    agenda_dropped: [],
    documents: [],
  };
}
