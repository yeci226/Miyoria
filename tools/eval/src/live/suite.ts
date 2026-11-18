// What a live suite is given and what it returns, and the registry the runner picks suites from.
// A suite scores a `Subject`; it never knows which one.

import type { Completer } from "@miyoria/llm/llm";
import { errorMessage } from "@miyoria/runtime/kernel";
import type { Judge } from "./judge.js";
import type { Meter } from "./meter.js";
import type { Subject } from "./subject.js";

/** What of `PersonaHandle` her writers read. */
export interface PersonaParts {
  corePrompt(): string;
  examples(): string[];
  names(): string[];
  displayName(): string;
}

export interface SuiteContext {
  subject: Subject;
  judge: Judge;
  /** The run's meter: a suite stops when it has refused a call (`stopped: "budget"`). */
  meter: Meter;
  /**
   * The run's router, for a suite that calls the model itself instead of going through the subject
   * (the words on a card, the turtle-soup referee). Unset in a test with no model: such a suite
   * is then skipped.
   */
  router?: Completer;
  /** Her persona (identity and style), for a judge that scores her voice. */
  persona: string;
  /**
   * Her persona as her chat reads it (`PersonaHandle`: the persona sections, the example dialogues,
   * her names), for a suite that calls her writers itself (`play`). Unset: `persona` stands in.
   */
  handle?: PersonaParts;
  /** Every item is run this many times. */
  repeat: number;
  /** Seeds whatever a suite draws (the order two replies are shown in). */
  seed: string;
  /** Progress, one line per item. */
  log(line: string): void;
}

export interface SuiteResult {
  suite: string;
  /** One or two numbers between 0 and 1 (`null`: nothing could be scored). */
  headline: Record<string, number | null>;
  /** Per-item detail, in the order run. */
  items: unknown[];
  /** Items the subject cannot be shown, with the reason; never counted as pass or fail. */
  unsupported: { id: string; reason: string }[];
  /** Lines the report prints under the suite's own (a table of the suite's parts). */
  report?: string[];
  /** The run's limit was reached: what is here is what finished before it. */
  stopped?: "budget";
  /** The suite did not run, and why. */
  skipped?: string;
}

export type SuiteRunner = (ctx: SuiteContext) => Promise<SuiteResult>;

/**
 * The suites by name. A name registered with `null` is a slot: the suite is known, and its runner
 * is supplied from outside (`memory`: the recall harness is wired in by the caller).
 */
export class SuiteRegistry {
  readonly #suites = new Map<string, SuiteRunner | null>();

  register(name: string, runner: SuiteRunner | null): this {
    this.#suites.set(name, runner);
    return this;
  }

  has(name: string): boolean {
    return this.#suites.has(name);
  }

  get(name: string): SuiteRunner | null {
    return this.#suites.get(name) ?? null;
  }

  names(): string[] {
    return [...this.#suites.keys()];
  }
}

export type Step<T> =
  | { kind: "ok"; value: T }
  /** The budget refused a call while it ran (or before it could start): its result is dropped. */
  | { kind: "stopped" }
  | { kind: "error"; error: string };

/** Runs one item of a suite: a budget stop and a failure are results, not throws. */
export async function attempt<T>(meter: Meter, step: () => Promise<T>): Promise<Step<T>> {
  if (meter.spent()) return { kind: "stopped" };
  const before = meter.refusals();
  try {
    const value = await step();
    // A refused call inside her brain is not an error there: she falls back to a canned line.
    return meter.refusals() > before ? { kind: "stopped" } : { kind: "ok", value };
  } catch (error) {
    if (meter.refusals() > before) return { kind: "stopped" };
    return { kind: "error", error: errorMessage(error) };
  }
}

export const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

export const share = (hits: number, of: number): number | null => (of === 0 ? null : hits / of);
