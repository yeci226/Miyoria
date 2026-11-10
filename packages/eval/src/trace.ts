// What happened (or what the code under test did), as a flat list of events with the seconds
// since the start of the fixture. A recorded incident, a hand-written control and the output of a
// subject are all this one shape, so the same checks run on every one of them.

import { z } from "zod";

const At = z.number().nonnegative();

export const TraceEventSchema = z.discriminatedUnion("type", [
  /** Someone spoke or wrote to her. `text` is kept only where a check needs it. */
  z.object({
    type: z.literal("heard"),
    t: At,
    who: z.string(),
    text: z.string().optional(),
    /** The owner told her to stop doing something (`prohibition`) or to start again (`release`). */
    intent: z.enum(["prohibition", "release"]).optional(),
  }),
  /** One line she said or wrote (what people saw or heard, after the parser). */
  z.object({
    type: z.literal("said"),
    t: At,
    channel: z.enum(["voice", "text"]),
    text: z.string(),
  }),
  /** A tool she called (`native`) or only wrote down as text (`native: false`). */
  z.object({
    type: z.literal("call"),
    t: At,
    tool: z.string(),
    native: z.boolean(),
    args: z.unknown().optional(),
  }),
  /** One request that reached the gate (an audit row) and what happened to it. */
  z.object({
    type: z.literal("gate"),
    t: At,
    capability: z.string(),
    principal: z.string(),
    allowed: z.boolean(),
    args: z.unknown().optional(),
  }),
  /** Something she became aware of (a status line, an error). */
  z.object({
    type: z.literal("observe"),
    t: At,
    source: z.string(),
    text: z.string(),
    error: z.boolean().optional(),
  }),
  /** One decision of the game director: what she chose and how it ended. */
  z.object({
    type: z.literal("game_step"),
    t: At,
    action: z.string(),
    /** What the action is about (`bread`), part of the goal's key. */
    target: z.string().optional(),
    failed: z.boolean(),
    detail: z.string().optional(),
    /** The failure guard withheld it: it never ran. */
    blocked: z.boolean().optional(),
  }),
]);
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type Trace = TraceEvent[];

export function ofType<T extends TraceEvent["type"]>(
  trace: readonly TraceEvent[],
  type: T,
): Extract<TraceEvent, { type: T }>[] {
  return trace.filter((e): e is Extract<TraceEvent, { type: T }> => e.type === type);
}
