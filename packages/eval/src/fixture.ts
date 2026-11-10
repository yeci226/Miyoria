// The fixture format: one real incident as a JSON file (docs/design/v3-architecture.md §18.2).
//
// `trace` is what happened. `checks` are the rules she broke. `harness` says which part of the
// code is asked the same question today (see `subjects/`); `trace` alone has no code to run and
// can only be judged again on a fresh recording. `control` is what a correct run looks like: the
// checks must pass on it, or a check that nothing can satisfy would count as a "caught" incident.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CheckSchema } from "./checks.js";
import { TraceEventSchema } from "./trace.js";

export const HARNESSES = ["parser", "guard", "rule", "attention", "wish", "trace"] as const;
export type Harness = (typeof HARNESSES)[number];

export const FixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string(),
    category: z.enum([
      "tool_as_text",
      "game_loop",
      "owner_rule",
      "honesty",
      "repeat",
      "fault",
      "attention",
    ]),
    incident: z.object({
      /** Local time of the first event (ISO 8601 with offset). */
      at: z.string(),
      summary: z.string(),
      /** Where the rows came from (table and seq range), for finding them again. */
      source: z.array(z.string()).min(1),
    }),
    harness: z.enum(HARNESSES),
    /** Harness input that is not the trace itself (the `rule` harness: the rule). */
    input: z.record(z.string(), z.unknown()).optional(),
    trace: z.array(TraceEventSchema).min(1),
    control: z.array(TraceEventSchema).optional(),
    checks: z.array(CheckSchema).min(1),
    /** `pass`: green today. `xfail`: broken today for `reason`; it flips when `flips_with` lands. */
    status: z.enum(["pass", "xfail"]),
    reason: z.string().optional(),
    flips_with: z.string().optional(),
  })
  .refine((f) => f.status === "pass" || (f.reason !== undefined && f.flips_with !== undefined), {
    message: "an xfail fixture needs a reason and flips_with",
  });
export type Fixture = z.infer<typeof FixtureSchema>;

export function parseFixture(json: string, name = "fixture"): Fixture {
  try {
    return FixtureSchema.parse(JSON.parse(json));
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures");

export function loadFixtures(dir = FIXTURE_DIR): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => parseFixture(readFileSync(join(dir, f), "utf8"), f));
}
