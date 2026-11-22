// When the nightly tidy of her notes runs (`notes/src/tidy.ts` does the tidy itself): once a local
// day, after the daily reflection and the pass on people are over and it is quiet
// (`Reflector.nightOver`), under the text runner's accounting of the nightly figure
// (`ReflectGuardKey`, a job row of kind `reflect` named 整理筆記), with its own cap on top
// (`[modules.reflect.tidy] budget_usd`). It tells nobody: the job row, a log line with the counts
// and the history of the documents are what is left of it.
//
// Kept in the settings store (`reflect:tidy`): the local day it last ran, and when each document
// was last tidied, so the documents rotate (one unchanged since is not taken again).

import type { Completer } from "@miyoria/llm/llm";
import { sessionId } from "@miyoria/llm/llm";
import type { ServiceLookup } from "@miyoria/runtime/kernel";
import { errorMessage } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import { type Clock, isJsonObject, type ProfileId, ReflectGuardKey } from "@miyoria/types";
import type { NotesStore } from "../../notes/src/store.js";
import { type TidyReport, tidyNotes, tidySummary } from "../../notes/src/tidy.js";
import type { TidyNightConfig } from "./config.js";

export const TIDY_STATE_KEY = "reflect:tidy";
/** The goal on the job row. */
export const TIDY_GOAL = "整理筆記";
const DAY_MS = 86_400_000;
/** How long a document's last tidy is remembered (after that it counts as never tidied). */
const KEEP_MS = 90 * DAY_MS;

export interface NightlyTidyDeps {
  config: TidyNightConfig;
  /** The model chain of the nightly passes (`[modules.reflect] purpose`). */
  purpose: string;
  utcOffsetMinutes: number;
  profile: ProfileId;
  store: SettingsStore | null;
  clock: Clock;
  log: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
}

const localDay = (now: number, offsetMinutes: number) =>
  new Date(now + offsetMinutes * 60_000).toISOString().slice(0, 10);

export class NightlyTidy {
  readonly #d: NightlyTidyDeps;
  #day: string | null = null;
  readonly #tidied = new Map<string, number>();

  constructor(deps: NightlyTidyDeps) {
    this.#d = deps;
  }

  async load(): Promise<void> {
    const store = this.#d.store;
    if (store === null) return;
    const state = await store.get(this.#d.profile, TIDY_STATE_KEY);
    if (!isJsonObject(state)) return;
    this.#day = typeof state.day === "string" ? state.day : null;
    if (isJsonObject(state.documents)) {
      for (const [id, at] of Object.entries(state.documents)) {
        if (typeof at === "number") this.#tidied.set(id, at);
      }
    }
  }

  /** When each document was last tidied (epoch ms). */
  lastTidied(): ReadonlyMap<string, number> {
    return this.#tidied;
  }

  /** Whether tonight's tidy is due: on, not run today, and the night's reflections are over. */
  due(now: number, nightOver: boolean): boolean {
    return (
      this.#d.config.enabled && nightOver && this.#day !== localDay(now, this.#d.utcOffsetMinutes)
    );
  }

  async #save(): Promise<void> {
    const store = this.#d.store;
    if (store === null) return;
    const now = this.#d.clock.now();
    const documents: Record<string, number> = {};
    for (const [id, at] of this.#tidied) {
      if (now - at <= KEEP_MS) documents[id] = at;
      else this.#tidied.delete(id);
    }
    try {
      await store.set(this.#d.profile, TIDY_STATE_KEY, { day: this.#day, documents });
    } catch (error) {
      this.#d.log.warn({ err: errorMessage(error) }, "cannot keep the state of the notes tidy");
    }
  }

  /**
   * Tonight's tidy. The day is marked first (a crash in it is no loop); nothing runs when the
   * nightly figure is used up. Returns its report, or `null` when nothing ran.
   */
  async run(
    services: ServiceLookup,
    notes: NotesStore | null,
    router: Completer | undefined,
    signal: AbortSignal,
  ): Promise<TidyReport | null> {
    const d = this.#d;
    this.#day = localDay(d.clock.now(), d.utcOffsetMinutes);
    await this.#save();
    if (notes === null || router === undefined) return null;
    const tidy = (within: AbortSignal) =>
      tidyNotes(
        {
          notes,
          router,
          purpose: d.purpose,
          clock: d.clock,
          config: d.config,
          lastTidied: this.#tidied,
          tidied: (id, at) => {
            this.#tidied.set(id, at);
          },
          session: sessionId(d.profile, "reflect-tidy"),
          warn: (fields, message) => d.log.warn(fields, message),
        },
        within,
      );
    let report: TidyReport | null = null;
    try {
      const guard = services.get(ReflectGuardKey);
      if (guard === undefined) {
        report = await tidy(signal);
      } else {
        const out = await guard.run(tidy, signal, { goal: TIDY_GOAL, summarise: tidySummary });
        if (!out.ran) {
          d.log.info({ why: out.why }, "the notes tidy did not run");
          return null;
        }
        report = out.result;
        if (report === null && !signal.aborted) {
          d.log.warn({ why: out.why }, "the notes tidy failed");
        }
      }
    } catch (error) {
      if (!signal.aborted) d.log.warn({ err: errorMessage(error) }, "the notes tidy failed");
    } finally {
      await this.#save();
    }
    if (report !== null) {
      d.log.info(
        {
          documents: report.documents,
          groups: report.groups,
          tidied: report.tidied,
          dropped: report.dropped,
          lines_before: report.lines_before,
          lines_after: report.lines_after,
          calls: report.calls,
          cost_usd: Math.round(report.cost_usd * 10_000) / 10_000,
          tokens: report.tokens,
          stopped: report.stopped,
        },
        "the notes were tidied",
      );
    }
    return report;
  }
}
